# Desktop user-message lifecycle: mid-turn send parity, and edit sent message

**Date:** 2026-08-16
**Area:** terminal engine (`src/`), Electron desktop app (`app/`), transcript persistence
**Status:** Part A is a source-verified findings report. Part B is a proposed implementation plan (absorbed from `docs/migration/specs/2026-08-13-desktop-edit-sent-message-implementation-plan.md`, revised after adversarial review, unbuilt).

Two questions about the same object — a user message the operator has already committed to:

- **Part A. What happens to a message sent while a response is still running?** Traced in current source on both surfaces and compared.
- **Part B. What would it take to edit a message already sent?** The desktop has no engine seam for it; this is the plan.

They are merged here because they share one substrate: the engine command queue, the active conversation chain, and the sidecar's turn latch. Part B's transaction must block Part A's drain, and Part A's defects change Part B's guard set. Section 3 states those couplings explicitly.

All claims below are anchored to current source. Dated docs are not evidence; where this report and source disagree, source wins.

---

# Part A — Sending during a running response

## A1. The mechanism is already at parity

Both surfaces place mid-turn text on the **same engine queue**, and the running turn drains it at its next tool round. This is real steering, not a next-turn deferral.

| Step | Terminal (TUI) | Desktop |
|---|---|---|
| Input accepted mid-turn | Never disabled; focus ignores `isLoading` (`src/components/PromptInput/PromptInput.tsx:2238`) | `turnPending` gate keeps the composer editable (`app/renderer/src/composerState.ts:555-564`) |
| On Enter | `enqueue({mode:'prompt'})`, default priority `next` (`src/utils/handlePromptSubmit.ts:414-421`, `src/utils/messageQueueManager.ts:168-172`) | `handleSubmit` sees `activeTurn` and calls `enqueueMidTurnPrompt` → same `enqueue` (`app/sidecar/sidecarServer.ts:1717`, `:1751`, `:1599-1609`) |
| Delivery into the running turn | Drained after a tool round, injected as an attachment (`src/query.ts:1765-1791`, `src/utils/attachments.ts:1055-1092`) | Identical: the sidecar never calls `AppSessionController.submit` for this path, so the engine's own drain owns it |
| Wording the model sees | `The user sent a new message while you were working: …` (`src/utils/messages.ts:5735-5747`) | Same string, same code |
| Slash commands | Excluded from mid-turn drain by `isSlashCommand` (`src/query.ts:1772`) | Same filter, same engine |
| Turn ends with no further tool round | Boundary drain runs it (`src/hooks/useQueueProcessor.ts:48-60`) | `drainOneQueuedPrompt` starts a turn with `announcePrompt:false` (`app/sidecar/sidecarServer.ts:1286-1338`) |

One qualification that applies to both: the drain sits inside the `needsFollowUp` branch of the agent loop, and `needsFollowUp` is only true when the assistant emitted `tool_use` blocks (`src/query.ts:954`, branch at `:1217-1536`). A **text-only** response never steers; the message waits for the boundary. "Mid-response" means "at the next tool round of the same turn", never mid-token.

`turn_already_running` (`app/sidecar/sidecarServer.ts:1760-1781`) is now effectively dead on this path: it survives only for a `startTurn` failure that is not `activeTurn`.

## A2. Divergences, ranked by user impact

### D1 — The TUI stages the message; the desktop commits it

TUI: the queued message is rendered as a real user row **above the composer** (`src/components/PromptInput/PromptInputQueuedCommands.tsx:96-131`), and it is recallable. `↑` pops every editable queued command back into the composer with pasted images restored (`src/components/PromptInput/PromptInput.tsx:951-956`, `:1275-1297`, `src/utils/messageQueueManager.ts:485-541`), advertised by the placeholder `Press up to edit queued messages` (`src/components/PromptInput/usePromptInputPlaceholder.ts:49-56`). Esc pops one when no turn is running (`src/hooks/useCancelRequest.ts:87-115`); the second kill press clears the queue (`:253`). Sending mid-turn is a staged, reversible act.

Desktop: `enqueueMidTurnPrompt` broadcasts the user message into the transcript **immediately**, before the engine has seen it (`app/sidecar/sidecarServer.ts:1601` → `:1573-1594`). It renders as an ordinary sent message; the projector models only pending/success/error and has no queued state (`app/renderer/src/TranscriptView.tsx:1412-1417`). The `Queued` row that does exist is the cold-spawn park, not this case (`app/renderer/src/App.tsx:4754-4763`, `Sends when the session is ready.`). There is no recall, no dequeue verb on the wire, and no cancel control.

The sidecar's own comment gives the reason for broadcasting: the queue offers no consumption signal the sidecar can observe without reaching into engine internals. That justifies showing *something*; it does not justify showing it as indistinguishable from a delivered message.

**Effect:** on the desktop, Enter mid-turn is irreversible, and the user is given no way to tell a steering message apart from a sent one.

### D2 — Mid-turn image messages can be dropped without any signal

`buildSubmitPrompt` emits a content-block **array** when images are attached (`app/renderer/src/composerState.ts:163-179`), and `enqueueMidTurnPrompt` enqueues that array as `value` (`app/sidecar/sidecarServer.ts:1602`). But the sidecar's own predicate requires a string:

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

Consequences, read directly off the code:

1. it does not count toward `MAX_QUEUED_PROMPTS` (`:1722`);
2. it is **not** rescued by `drainOneQueuedPrompt` (`:1286`, which dequeues on that predicate);
3. it does not hold the park gate open (`hasQueuedParentPrompt`, `:1859-1866`).

The engine's own drain has no string requirement (`src/query.ts:1774`), so the message *is* delivered when a tool round happens. When the turn ends first, the user is left looking at their message in the transcript while the model never received it — and the session may park with it still queued. The TUI handles images on both paths (`src/utils/attachments.ts:1073-1082` mid-turn; `popAllEditable` restores them on recall).

No test covers the mid-turn + image path.

### D3 — Boundary drain: one turn per message, versus one turn for all

TUI: `processQueueIfReady` dequeues all non-slash commands sharing a mode and passes them as one array (`src/utils/queueProcessor.ts:52-87`); `executeUserInput` folds them into a **single** `onQuery` (`src/utils/handlePromptSubmit.ts:551-660`), with attachments attached to the first only.

Desktop: `drainOneQueuedPrompt` is exactly one prompt per turn, rescheduled by each turn finalizer (`app/sidecar/sidecarServer.ts:1286-1338`, `:1262-1274`, `:1456-1478`).

**Effect:** three messages queued at a boundary produce one turn in the terminal and three sequential turns on the desktop. Already recorded as D2 of `docs/reports/2026-08-08-migration-branch-review/X02a-atomic-writes-duplication.md`.

### D4 — Depth cap rejects a message whose text has already been discarded

The TUI queue is unbounded (`src/utils/messageQueueManager.ts:169`). The desktop caps depth at `MAX_QUEUED_PROMPTS = 32` (`app/shared/limits.ts:68`), each ≤ `MAX_PROMPT_BYTES` 96 KiB (`:54`). The cap itself is defensible and documented in place: the sidecar's writer is a renderer, not necessarily a keyboard.

The loss is on the rejection path. `submitSession` retires the draft synchronously at send (`app/renderer/src/App.tsx:2326-2328`), so when the sidecar answers `bad_request` / `Too many messages are already waiting for this response.` (`app/sidecar/sidecarServer.ts:1723-1731`, pinned by `app/sidecar/sidecarServer.test.ts:1436-1452`) the text is already gone from the composer, recoverable only through `↑` history. It surfaces as the dismissible red log line (`app/renderer/src/rawMessageLog.ts:132-144`, `app/renderer/src/App.tsx:4728-4741`), not as a composer-level failure.

### D5 — Stop does not cancel it (on either surface), and only the TUI offers a way out

Abort does not touch the queue on either side: `app.abort` calls `controller.abort` only (`app/sidecar/sidecarServer.ts:1209-1221`), and the TUI's `onCancel` leaves the queue intact (`src/screens/REPL.tsx:2335`, `:2370`). In both cases the queued message then runs as the next turn. The difference is escape hatches: the TUI has `↑` recall and a queue clear, the desktop has neither. A renderer-*parked* prompt (cold spawn / idle park) is released on Stop (`app/renderer/src/App.tsx:4266-4278`, `app/renderer/src/composerState.ts:760-764`), but that is a different state from a mid-turn send.

## A3. Fix order proposed

1. **D2** — smallest change, only defect that silently loses a user message. Either accept content-block values in `isDeliverableParentPrompt`, or reject image-bearing mid-turn submits explicitly. Needs a boundary test for both the delivered and the never-drained case.
2. **D1** — the behavior gap that is actually felt. Requires a design decision, because a genuine recall implies a new inbound verb to dequeue, which is a sidecar-vocabulary change under `SECURITY-MINIMUM.md` (schema + boundary test + decision reference). A cheaper interim: mark the row as not-yet-delivered rather than making it retractable.
3. **D3** and **D4** — both small and independent. Batch the boundary drain; retain the draft until the submit is acknowledged.

D5 needs no fix beyond D1; it is the same missing affordance.

---

# Part B — Edit sent message (implementation plan, unbuilt)

Absorbed verbatim in substance from `docs/migration/specs/2026-08-13-desktop-edit-sent-message-implementation-plan.md` (2026-08-13, proposed, revised after adversarial review). Nothing in this part is built.

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

These are prerequisites, not deferrable details.

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

Only top-level, operator-authored turns are editable. Not eligible: synthetic or metadata user messages; task-notification messages; tool-result user messages; replay-only messages; subagent-sidechain messages; command or generated bookkeeping rows without a resubmittable prompt.

The engine is authoritative; renderer filtering is presentation only. Eligibility uses one canonical engine predicate requiring an absent or `human` message origin in addition to the existing exclusions — the terminal selector alone is insufficient, because other engine-authored origins still carry a user role.

Visible operator messages before the latest compact boundary remain in scope, resolved through the persisted active parent chain and canonical resume machinery. Do not render an edit affordance `QueryEngine.mutableMessages` cannot honor.

### Explicit non-goal

Arbitrary deletion of one historical user message while retaining later assistant responses. Those responses causally depend on the removed prompt. A future **Remove from here** may reuse the rewind machinery, but it needs an explicit durable branch-head representation when no replacement follows.

## B4. Architecture

Six layers: (1) canonical persisted active-chain and durable transaction primitives; (2) canonical QueryEngine rewind capability; (3) app-runtime controller operation; (4) strict desktop sidecar and protocol boundary; (5) renderer transcript and composer state; (6) accessible per-turn controls and confirmation UI.

The renderer must never author conversation contents other than the replacement prompt it already owns. It may select an engine-minted message UUID and a closed rewind scope. The engine derives target, affected suffix, prior permission mode, file checkpoint, and current head.

## B5. Phase 0 — required engine prerequisites

Files: `src/utils/sessionStorage.ts`, `src/utils/sessionRestore.ts`, `src/utils/fileHistory.ts`, `src/services/deferredContinuation.ts`, `src/commands/branch/branch.ts`, plus colocated tests.

### Canonical active-chain resolver

One engine-owned resolver over the persisted parent topology. It must:

1. Parse edit transaction records before choosing or pruning leaves.
2. Select the latest committed active leaf by valid JSONL append order, not timestamps; ignore transaction-associated replacements without a commit.
3. Resolve a pre-compaction target through persisted display topology, following compact `logicalParentUuid` ancestry.
4. Derive a new retained model chain from that archival path ending immediately before the target — excluding the abandoned compact boundary, summary, and later suffix — then pass it through existing resume normalization and state restoration. Never feed display projection rows to the model.
5. Preserve compact-boundary semantics rather than reconnecting summarized history into the ordinary model seed.
6. Return active target, retained prefix, abandoned suffix, compact seams, reachable content replacements, and current head.
7. Distinguish the engine transcript identity from the desktop app-session address throughout.

Use it for edit preview/submit, and fix `createFork()` to fork only the authoritative active chain. Branch must also require an idle turn and a durable transcript flush before capturing HEAD. Make this resolver the common active-leaf owner for ordinary resume, display loading, edited replay, and Branch. The large-transcript `walkChainBeforeParse()` optimization must become transaction-aware or stay disabled until the committed leaf is known; it must not prune the last committed fallback branch while an incomplete transaction exists.

### Durable input commit

An awaited engine-owned commit primitive. A plain replacement append is not enough: once written, latest-leaf resume can select it even if the rest of the transaction failed. Introduce an append-only edit transaction record with prepare / abort / commit states:

1. Closed versioned shapes for each record, plus the replacement message's transaction association.
2. Terminal state determined by the latest valid record in JSONL append order, never by timestamp.
3. A durable prepare names transaction, renderer operation ID, transport request ID, target, expected head, replacement UUID, scope, and engine-owned file rollback checkpoint.
4. The inactive replacement is appended and made durable with the prepare before any file changes. Active-chain resolution and ordinary resume ignore it until a matching commit exists.
5. A handled failure before commit append restores transaction-owned files and appends a durable abort. Abort is never legal after commit append begins.
6. A readable valid commit is irrevocable and makes the replacement the active leaf.
7. Once commit append begins, append/fsync/verification/parent-directory-sync uncertainty enters `outcome_ambiguous`: no pre-commit rollback, no ordinary success or failure. Keep session mutation blocked, reopen and reconcile under the session lock, retry durability; if no durable terminal state can be established, report the typed ambiguous outcome and keep the session blocked for startup recovery.
8. Startup resolves an incomplete or ambiguous transaction before accepting another turn, rolling files back only when they still match the transaction's applied fingerprint; otherwise preserve the newer content and report a conflict.

This is additive persistence metadata, not a destructive JSONL rewrite or a renderer-authored branch head. Use `flushCurrentTranscriptDurably()` guarantees rather than treating `onInputPersisted` as the commit point.

Existing transcript queues and file-operation chains are process-local. Add one engine-owned cross-process mutation lock keyed by engine session ID; every main-thread transcript append, edit transaction/recovery, and Branch HEAD snapshot participates. The edit transaction holds it from expected-head validation through terminal-state reconciliation. Branch shares the in-process edit/admission latch and rejects while an edit is open. Transcript write APIs accept an owned lock guard so transaction appends reuse it. Define and test one lock ordering across the sidecar admission latch, engine-session mutation lock, transcript queue, and workspace fingerprint checks.

Reject when session persistence is disabled. Test enqueue failure, flush failure, fsync failure, UUID verification failure, restart after acknowledgement, and persistence-disabled mode, with fault points after prepare, inactive replacement, file apply, commit append, transcript fsync, commit verification, and parent-directory fsync — including a large transcript above the pre-parse pruning threshold with an incomplete transaction and an older committed head.

### Strict file-history transaction

Do not treat best-effort `fileHistoryRewind()` or its preview helpers as proof a transaction can commit. Add a strict operation that fails closed on unavailable snapshot or backup; preflights every target file before writing; captures enough state to roll back applied writes and deletes; records preflight and intended-applied fingerprints per path; compares the current fingerprint immediately before each apply or rollback and never overwrites a path changed by another process; applies all transaction-owned changes or restores each still-owned path, preserving concurrent modifications as a typed conflict with the conversation left uncommitted; and returns structured changed paths, conflicts, and failures. Preview must distinguish zero changes from an unavailable or unreadable snapshot.

### Human-takeover guard

Route every renderer-authored human submit, including an edited submit, through `prepareHumanPromptAgainstDeferredContinuation()` before starting a turn. Pending or ambiguous continuations are canceled atomically; submitted or running attempts return a typed retryable failure. Engine-authored task notifications do not use this guard.

Because that operation is asynchronous, add a synchronous FIFO human-submit admission latch at sidecar dispatch before the first await. It must serialize ordinary and edited submissions; preserve arrival order for mid-turn prompts; count pending admissions toward the existing queue-depth bound; block park, Branch, edit, and boundary drains; transfer ownership atomically to `activeTurn`, the bounded command queue, or the edit transaction; and release on typed takeover refusal or validation failure. Continuation cancellation completes before the prompt is announced as accepted.

## B6. Phase 1 — canonical engine rewind capability

Files: `src/QueryEngine.ts`, `src/app-runtime/createQueryEngineAppSession.ts`, `src/app-runtime/createQueryEngineSessionController.ts`, `src/app-runtime/AppSessionController.ts`, colocated tests.

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

Do not expose `mutableMessages` or a separately callable destructive apply step through the app-runtime interface. Rewind and replacement remain one operation. The edited operation owns one complete turn: it processes the replacement prompt exactly once, commits that exact user-message UUID, invokes `onEditedInputCommitted` synchronously, then enters the query loop with the already-accepted message. It must not re-run the ordinary prompt processing/persistence prefix.

**Preview** resolves the target through the canonical persisted active chain (rehydrating intended ancestry through the resume path when it precedes a compact boundary); validates with the canonical authorship predicate; identifies the current head; returns a revision token based on the head UUID; returns canonical resubmittable prompt content and input metadata (collapsed-paste pills are renderer-local and cannot be reconstructed — restore expanded text, never invented placeholder metadata); counts the suffix to be removed; reports whether it contains non-synthetic messages; and returns the selected message's permission mode when present.

**Edited submit** stages the rewind internally: repeat eligibility checks against current state; reject on `expectedHeadUuid` mismatch; rebuild `mutableMessages` as the canonical retained chain immediately before the selected message (possibly reseeding from persistence for a pre-compaction target); restore permission mode through the existing engine-owned app-state path; clear or recompute active-chain-derived state (permission-denial accumulation, context-collapse/compaction state, context-window calculations, prompt suggestions, `readFileState`, `loadedNestedMemoryPaths`, `AppState.fileHistory` rebuilt from snapshots reachable through the retained chain); preserve monotonic accounting such as cumulative usage and cost; and return the retained head plus canonical replay.

**Persistence rule.** Do not use `removeTranscriptMessage()` — it physically removes an orphaned streaming entry and is not a rewind primitive. The transcript stays append-only; the amended message starts a new parent chain from the retained branch point, and the abandoned suffix remains historical data that is no longer reconstructed as the active conversation.

**Atomicity.** One engine-owned transaction: acquire a synchronous per-session edit latch before the first await; validate target and expected head; strictly preflight files when restoration is selected; revalidate after asynchronous preparation; process the replacement once and stage retained engine/AppState, exact replacement message, and canonical replay in memory; append and durably verify prepare plus the inactive replacement before changing files; apply the preflighted file transaction with fingerprint checks; begin commit append (irrevocable if readable; uncertainty follows reconciliation, not rollback); flush, fsync, verify commit and replacement, sync the parent directory; swap in the staged state with a non-failing update; invoke the sidecar's synchronous committed-input callback, which updates the attach-time replay source and queues applied plus canonical replay before the query loop emits any output; and, before commit append only, restore prior state and every still-owned file on failure then append abort.

The sidecar must not emit success at `onInputPersisted`. The edit latch blocks or fails ordinary submit, park, **queued-prompt drain**, task-notification drain, permission handling, and a second edit while the transaction is open. Edited submit and Branch also reject when the authoritative task domain reports running or pending work, revalidated before preparation, after preparation, and immediately before file application/commit.

**Controller guards.** Reject preview and edited submit when a turn is active; a permission request is pending; the target is absent from the current active chain; the target is not an eligible user turn; persistence is disabled; or another edit transaction owns the latch. Edited submit additionally rejects on stale expected head, a submitted or running deferred continuation, and a running or pending background task. Preview stays read-only and may report while background work exists, but its expected head is advisory only.

## B7. Phase 2 — file-history preview and restoration

Reuse checkpoint formats and comparison/backup helpers behind `fileHistoryGetDiffStats` and `fileHistoryHasAnyChanges` (`src/utils/fileHistory.ts`), but never use either best-effort public operation as a strict preview or transaction decision. Extract their low-level helpers into strict engine-owned preflight/apply/rollback beside them. Do not duplicate file-checkpoint logic under `app/`.

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

No file contents, no renderer-authored paths. For `conversation-and-files`, invoke the strict transaction against the sidecar's real `AppStateStore`. Before commit append, any preflight/restoration/persistence failure aborts the edit and rolls back every still-owned path; a concurrent file modification is preserved and returned as `restoration_conflict`, never overwritten to manufacture an all-files rollback claim. After commit append, reconcile without rolling files back. Invalidate changed paths in `readFileState`.

## B8. Phase 3 — desktop protocol and sidecar boundary

Files: `app/shared/protocol.ts`, `app/sidecar/sidecarServer.ts`, `app/sidecar/sessionController.ts`, `app/sidecar/sessionActionsDomain.ts` (or a dedicated adjacent domain), `app/main/main.ts`, `app/preload/preload.ts`, plus boundary, source-guard, and hardening tests.

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

Define `EditablePrompt` once as the existing bounded text/base64-image submit subset, canonical in the app-runtime contract and consumed by type-only import in the wire contract; use it in preview result, renderer edit state, edited submit, and the QueryEngine API. Keep strict boundary-local schemas in the web and desktop sidecars with the same count and byte limits, rejecting every other engine content-block variant.

**Edited submit gets its own verb.** Do not extend `app.submit.options`: main strips unknown options, the sidecar rejects unknown keys, and the renderer cannot correlate the main-minted submit request ID.

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

The renderer mints the bounded `operationId`; main continues to mint the transport `requestId`; both are echoed on every success or rejection so late frames cannot consume a newer edit state. The dedicated verb is intercepted as app-local vocabulary **before** the shared browser `app.submit` schema, so that schema is not widened accidentally. After a valid `operationId` is parsed, rejection uses a bounded result frame carrying both IDs, a closed code, retryability, and a redacted message.

Closed result codes: `stale_head`, `live_work`, `continuation_running`, `persistence_disabled`, `transaction_busy`, `restoration_conflict`, `durability_ambiguous`, `invalid_target`, `internal_error`. `durability_ambiguous` is neither success nor ordinary rejection: the renderer retains the pending draft, disables another submit for that session, and waits for reconciliation or reconnect.

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

An edited turn starts with the ordinary optimistic prompt announcement disabled. After durable commit the sidecar emits, in order: `conversation-rewind.applied`; a canonical reset-and-replay of the active display chain including the replacement user message; then assistant, tool, and permission output. Build that replay through the same engine-seed plus archival-display pipeline used by `app/sidecar/index.ts`, including compact-boundary alignment and restored subagent history — no second mapper. Replace the attach-time history source with the newly committed replay before assistant generation starts.

Attach-time history becomes mutable with a monotonic `historyGeneration`. Every connection attach sends: ready and existing snapshots; `transcript-reset` for the current generation; the last matching applied or typed terminal-result frame when one exists; then the current canonical history replay. Both reset frames clear projector and raw-log state unconditionally; composer edit state clears only when an applied operation ID matches. A reconciled abort or conflict re-emits its typed result so an ambiguous pending draft can unlock without being discarded.

**Boundary requirements.** Strict Zod schemas and strict-key checks; capped strings and arrays; bounded `operationId` correlated on every response; target validated against the live engine chain; renderer UUIDs treated only as selectors; prompt content, counts, permission mode, file snapshot, and head derived from engine state; stale heads rejected; inbound/outbound frame-size distinctions preserved; existing rate limiter applied; outbound payloads through `secretGuard`; typed redacted failures that never crash the connection. The protocol change is additive and needs no version bump unless an existing shape must change incompatibly.

## B9. Phase 4 — renderer state and projection

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

Keyed by desktop session ID; switching tabs must not transfer an edit draft.

Flow: invoke **Edit sent message**; if the row is a cached preview or parked session, restore to engine-ready first, then request the authoritative preview (there is no replay-complete frame to wait for); enter edit mode directly only when the suffix is lossless **and** `fileChanges.available === true` with zero changed files (unavailable is not equivalent to zero); otherwise show a confirmation offering **Edit conversation**, **Edit and restore files** (when a checkpoint exists), and **Cancel**; populate the composer from the sidecar-returned prompt; show the banner `Editing an earlier message. Sending will discard later conversation.`; provide a visible **Cancel edit**; on send include target, expected head, and scope; retain the exact pending replacement until the matching `operationId` is accepted; clear edit mode only after the matching applied frame; retain the draft and show an actionable error on any typed failure; ignore late frames whose operation ID no longer owns the state.

`conversation-rewind.applied` resets the addressed session's projector and raw-log state; the immediately following canonical replay rebuilds visible and hidden rows, seen frame IDs, message and content-block indexes, tool correlations, streaming state, grouped tool runs, nested subagent joins, and selector caches. Do not rebuild from the raw-message log — it is independently capped, retains the abandoned suffix, and ignores non-event control frames. Do not hand-slice derived maps.

## B10. Phase 5 — user-turn controls

One SDK user message can project into text and image rows: add read-time user-turn grouping keyed by the engine frame UUID so one sent turn gets one action surface. Do not mutate stored projector rows to add UI state.

Every eligible top-level user turn exposes an edit button visible on hover **and** keyboard focus (`focus-within`, not hover-only), accessible name **Edit sent message**, keyboard activation, and focus styling consistent with existing controls. Image-only turns are editable. No control on synthetic, task-notification, replay-only, hidden metadata, tool-result, or subagent rows. Edit activation on a restorable or parked row restores the engine to ready first; tests must deliberately use different app-session and engine-session IDs.

Do not enable the disabled `Rewind…` item yet. After edit-and-resend ships, either rename it to **Edit earlier message…** opening the same picker, or define and implement durable no-resubmit rewind semantics before keeping the `Rewind…` label. The per-message control is a real-added surface; it does not close or relabel the parity ledger's deferred standalone `RewindDialog` and picker rows without a separate operator-approved adaptation.

## B11. Tests

**Engine / app-runtime.** Preview of an eligible message; rejection of unknown UUIDs and of synthetic, metadata, tool-result, subagent, and task-notification messages; rejection during an active turn and with a pending permission request; stale-head rejection; truncation immediately before the selected message; permission-mode restoration; compact and context-derived state reset; preservation of cumulative usage and cost; read-file and nested-memory cache handling; `AppState.fileHistory` rebuild; abort or recovery when prepare, replacement, or commit is not durable; durable active-chain reconstruction after resubmission; editing before a compact boundary; persistence-disabled rejection; deferred-continuation cancellation and running-attempt refusal; strict multi-file rollback; sibling-leaf and edited-session Branch behavior; large-transcript transaction-aware pruning and fallback-head recovery; one replacement UUID in memory and JSONL with prompt processing run once; fault injection at every prepare/replacement/file/commit/fsync boundary.

The persistence regression: user A → assistant A → user B → assistant B → rewind to user B → submit edited B2 → reload from disk → verify the active chain is A, assistant A, B2 and excludes the abandoned suffix. Repeat with user A before a compact boundary and user B after it, edit A to A2, restart, and verify both the display chain and the model seed follow the edited branch without reconnecting summarized history as live model context.

**Sidecar boundary.** Valid preview and edited submit; correlation by renderer-known operation ID; strict-key rejection; malformed, empty, and overlong UUIDs; stale target and stale head; non-user targets; both scopes; file-restoration failure preventing rewind; outbound secret screening; applied-before-output frame ordering; no assistant/tool/permission frame before applied plus replay; replay after reattachment; commit with zero connections followed by reset and replay on attach; reversed preview-response order and cancel/re-enter ownership; persistence-disabled, continuation, durability, and latch failures; FIFO ordinary/edited admission across continuation awaits; live foreground-agent and background-shell refusal; different app-session and engine-session IDs.

**Renderer.** One control per multi-block turn; none on ineligible rows; keyboard accessibility; direct edit for a lossless suffix; confirmation when messages or files are affected; cancel preserving transcript and prior draft; successful application truncating all derived state; stale-head errors retaining the draft; every typed failure retaining the exact pending replacement; per-session edit state across tab switches; text and image restoration; expanded-text restoration for a collapsed paste; cached-preview and parked-session restore-to-ready; applied-frame reset of raw-log and transcript state; attach-time generation reset into a renderer still holding the abandoned branch; durability-ambiguous retaining the draft and blocking resubmit.

## B12. Delivery sequence

1. **Engine transaction prerequisites** — active-chain resolver; durable edited-input commit; strict file preflight/apply/rollback; human-takeover guard; cross-process mutation lock; transaction-aware resume/display/pruning owner; correct active-chain Branch.
2. **Engine and app-runtime rewind seam** — preview and atomic edited-turn operations; controller guards, per-session latch, state reconstruction; single-pass edited-turn stream with committed-input callback; focused tests.
3. **Desktop sidecar and protocol boundary** — strict preview and edited-submit vocabulary; fixed preload sender and operation correlation; file-history integration; applied/reset/replay ordering; mutable generation-tagged attach history; boundary, replay, and two-ID tests.
4. **Renderer projection and composer state** — raw-log and projector reset/replay reducers; per-session edit state; restore-to-ready, late-response, failure, and cancel behavior.
5. **User interface** — user-turn grouping; accessible controls; confirmation dialog and banner.
6. **Integration and bookkeeping** — full batteries; exhaustiveness tripwire check; GUI acceptance; map, parity-ledger, and status updates.

## B13. Acceptance criteria

- An eligible sent user message can be selected from the desktop transcript and loaded into the composer.
- Canceling edit mode changes neither the active conversation nor persisted history.
- Sending an edited message discards the selected message and its dependent suffix from the active branch.
- Success is emitted only after the replacement and commit record pass the awaited flush, fsync, verification, and parent-directory-sync boundary.
- A readable commit encountered during a durability failure is irrevocable and enters typed reconciliation; it is never reported as an ordinary failed edit followed by file rollback.
- A stale conversation head fails closed without losing the edited draft, and every typed transaction failure preserves the exact edited draft.
- Optional file restoration reuses engine file-history formats through a strict, rollback-capable operation; concurrent writes are preserved and reported as typed conflicts.
- Reloading or resuming reconstructs the edited branch rather than the abandoned suffix; messages before a compact boundary are editable; branching an edited or compacted session follows only the authoritative active chain.
- Renderer projection contains no stale tool, streaming, subagent, hidden-row, or deduplication state after rewind, and the raw log and projector reset from the same canonical replay.
- A reconnect resets stale projection state even if no client was attached when the edit committed.
- The sidecar strictly validates every new inbound shape and the hardening suite passes.
- The edit control is keyboard accessible for text, mixed-content, and image-only turns.
- Cached-preview and parked sessions restore to ready before editing, without mixing app-session and engine-session IDs.
- Persistence-disabled sessions reject edit-and-resend explicitly.
- The full engine and desktop verification batteries pass.

---

# Section 3 — Where Part A and Part B meet

Merging these is not filing convenience. Four couplings are load-bearing:

1. **The edit latch must block the queued-prompt drain, and B7's plan already says so** (B6, Atomicity). Part A establishes that the drain is not hypothetical: `scheduleBoundaryDrain` fires from every turn finalizer (`app/sidecar/sidecarServer.ts:1456-1478`), so an edit transaction that does not hold the latch across its whole window can have a queued prompt start a turn on the branch it is mid-way through rewinding.

2. **D2 weakens two of Part B's guards.** `isDeliverableParentPrompt` is the same predicate behind `hasQueuedParentPrompt` (`:1859-1866`), which the plan's `live_work` and park refusals rely on. While image-bearing prompts are invisible to that predicate, an edited submit can pass a "no queued work" check with a mid-turn image prompt still on the queue. Fixing D2 is therefore a prerequisite for B6's guard set, not an unrelated bug.

3. **D1 and B10 want the same missing concept.** Part A needs a transcript row that means "sent but not yet delivered"; Part B needs one that means "about to be discarded". Both are read-time states over stored rows, and both must respect the standing rule that a projector row is never mutated after the fact. Design them once.

4. **D4 and B9 want the same draft policy.** Part A loses the draft on depth-cap rejection because the composer retires it at send; Part B's acceptance criteria require that every typed failure preserve the exact draft. One rule — retain until acknowledged — closes both.

---

# Verification

Part A is a read-only source trace; no code changed. Commands run for this document (docs-only battery per `CLAUDE.md` §3):

```bash
git diff --check
bun run maps:lint
```

Results are recorded in the commit that adds this file. Part B remains unbuilt; its battery is stated in B11 and its verification steps are:

```bash
bun test <focused engine and app-runtime test paths>
bun run build:dev:full
bun test app/
bun run --cwd app typecheck
bun run --cwd app typecheck:sidecar
bun run --cwd app test:hardening
bun run --cwd app renderer:build
```

plus: removing the new closed-union projector case temporarily and confirming the exhaustiveness tripwire fails; a stale-reference sweep for claims that desktop rewind has no engine seam; `docs/maps/web-app-runtime.md` if ownership routes change; the relevant `docs/migration/PARITY-LEDGER.md` rows; only the owning `docs/migration/STATUS.md` row; and operator-driven GUI acceptance for hover, keyboard focus, confirmation, cancellation, edited resend, file restoration, tab switching, and relaunch/resume.

# Open questions

1. **Whether a mid-turn message should be retractable at all on the desktop.** The terminal's `↑` recall exists because the queue is local to one process. A desktop equivalent requires a new inbound dequeue verb, which is a security-baseline change (schema, boundary test, decision record). The cheaper alternative — showing the row as not-yet-delivered without making it retractable — is a smaller lie but still a behavior difference from the terminal. Operator call.
2. **Whether the 32-prompt depth cap should surface differently.** It is currently a generic error line; a composer-level failure that restores the text would need the draft-retention change in D4 first.
3. **Timing of the mid-turn injection relative to streamed output** was not traced end to end. The drain is positioned after tool execution (`src/query.ts:1769`); the exact user-visible ordering against streamed assistant text is unverified.
4. **ESC precedence in the terminal** when a turn is running and a message is queued: the cancel handler's `stopImmediatePropagation` (`src/keybindings/useKeybinding.ts:70-73`) suggests abort wins and the composer's own pop is suppressed, but that depends on Ink listener ordering, which was not verified.
