# Desktop Edit Sent Message: Implementation Plan

**Date:** 2026-08-13
**Area:** Electron desktop app, app runtime, transcript persistence
**Status:** Proposed, revised after adversarial review

## Summary

The terminal UI lets the operator select an earlier user message, rewind the active conversation to immediately before that message, restore its content into the prompt input, edit it, and submit a replacement. The desktop application does not currently provide equivalent behavior.

This is not only a missing renderer button. The terminal implementation owns mutable conversation state directly inside `src/screens/REPL.tsx`, while the desktop renderer communicates with a separate engine sidecar through a closed protocol. Desktop support therefore requires a canonical engine rewind operation, strict sidecar and protocol wiring, renderer projection invalidation, composer edit state, and a user-facing edit control.

The implementation must preserve the locked desktop architecture:

- one engine process per desktop session;
- raw `AppSessionEvent` transport;
- the existing two-id model;
- strict sidecar validation of all renderer input;
- append-only transcript history rather than destructive JSONL rewriting.

### Review decisions that constrain implementation

Current source does not provide several primitives that the first draft assumed
were already sufficient:

- `QueryEngine.onInputPersisted` follows an enqueued local transcript append. It
  is not a durable flush-and-fsync barrier.
- `fileHistoryRewind()` is best-effort. It can skip preview failures and continue
  after per-file apply failures, leaving a partial restore.
- restored display history may contain an archival prefix that is no longer in
  `QueryEngine.mutableMessages` after compaction;
- the renderer does not know the main-minted `app.submit` request ID, and current
  main and sidecar submit sanitizers strip or reject a `rewind` option;
- projector state and the bounded raw-message log are not, individually, a
  complete authoritative source for rebuilding an edited active chain;
- `createFork()` currently linearizes all main-thread JSONL messages instead of
  following the active parent chain. Edit-and-resend would make that existing bug
  deterministic by deliberately creating an abandoned suffix.

These are prerequisites, not implementation details to defer. The feature must
introduce engine-owned active-chain, durable-commit, and strict file-restore
operations, and then use them from both edit-and-resend and affected sibling
flows.

## Current behavior and source anchors

### Terminal UI

The terminal message-actions feature is compiled into the development build through `MESSAGE_ACTIONS` in `scripts/build.ts`. `Shift+Up` enters message-action mode in `src/keybindings/defaultBindings.ts`, and `Enter` invokes the `edit` capability for a selected user message in `src/components/messageActions.tsx`.

The edit path in `src/screens/REPL.tsx`:

1. Locates the selected raw user message.
2. Checks whether rewinding would affect files or discard non-synthetic messages.
3. Opens a confirmation selector when the operation is consequential.
4. Truncates the active in-memory message array immediately before the selected message.
5. Restores the selected message's text, input mode, and pasted images into the prompt input.
6. Restores the permission mode associated with the selected message.

The terminal behavior is therefore **edit by rewind and resubmit**, not mutation of one historical message while retaining its dependent responses.

### Desktop application

Desktop user messages are projected as `user-text` and `user-image` rows in `app/renderer/src/transcriptProjector.ts` and rendered without an edit callback in `app/renderer/src/TranscriptView.tsx`.

The session-actions menu exposes `Rewind…`, but `app/renderer/src/sessionActions.ts` deliberately keeps it disabled because no engine conversation-rewind verb exists. The desktop protocol's closed session-action vocabulary in `app/shared/protocol.ts` currently contains rename, export, branch, and tag only.

`docs/migration/PARITY-LEDGER.md` records this as a deferred parity gap.

## Product semantics

### Edit sent message

When the operator edits an earlier user message:

1. The application requests an authoritative rewind preview from the sidecar.
2. The original message is loaded into the composer only after the sidecar confirms that it is editable.
3. Nothing is discarded while the operator is editing.
4. Canceling edit mode leaves the conversation unchanged.
5. Sending the edited message atomically:
   - verifies that the conversation head has not changed;
   - takes over or fails closed against any deferred continuation;
   - optionally restores files to the selected message's checkpoint;
   - rewinds the active conversation to immediately before the original message;
   - durably appends and fsyncs the amended message;
   - submits the amended message as the new branch tip.
6. The renderer removes the original message and its dependent suffix only after the sidecar accepts the rewind and replacement input.
7. Sessions with transcript persistence disabled do not expose edit-and-resend.
   The operation fails closed rather than claiming reload-safe atomicity for an
   in-memory-only branch.

### Eligibility

Only top-level, user-authored turns are editable. The following are not eligible:

- synthetic or metadata user messages;
- task-notification messages;
- tool-result user messages;
- replay-only messages that do not represent an operator-authored turn;
- subagent-sidechain messages;
- command or generated bookkeeping rows without a resubmittable operator prompt.

The engine is authoritative for eligibility. Renderer filtering is presentation only.

Eligibility uses one canonical engine predicate. It must require an absent or
`human` message origin in addition to the existing synthetic, metadata,
tool-result, sidechain, and notification exclusions. The terminal selector is
not sufficient by itself because other engine-authored origins can still carry a
user role.

Visible operator messages before the latest compact boundary remain in scope.
The engine must resolve them through the persisted active parent chain and
canonical resume machinery. Do not render an edit affordance that
`QueryEngine.mutableMessages` cannot honor.

### Explicit non-goal

Do not implement arbitrary deletion of one historical user message while retaining later assistant responses. Those responses causally depend on the removed prompt, so preserving them would create an invalid active chain.

A future **Remove from here** operation may reuse the rewind machinery, but it requires an explicit durable branch-head representation when no replacement message follows. It is not part of edit-and-resend parity.

## Architecture

The implementation is divided into six layers:

1. Canonical persisted active-chain and durable transaction primitives.
2. Canonical QueryEngine rewind capability.
3. App-runtime controller operation.
4. Strict desktop sidecar and protocol boundary.
5. Renderer transcript and composer state.
6. Accessible per-user-turn controls and confirmation UI.

The renderer must never author conversation contents other than the replacement prompt it already owns. It may select an engine-minted message UUID and a closed rewind scope. The engine derives the target, affected suffix, prior permission mode, file checkpoint, and current head.

## Phase 0: Required engine prerequisites

### Files

- `src/utils/sessionStorage.ts`
- `src/utils/sessionRestore.ts`
- `src/utils/fileHistory.ts`
- `src/services/deferredContinuation.ts`
- `src/commands/branch/branch.ts`
- Colocated transcript, restore, file-history, deferred-continuation, and Branch tests

### Canonical active-chain resolver

Add one engine-owned resolver over the persisted parent topology. It must:

1. Parse edit transaction records before choosing or pruning leaves.
2. Select the latest committed active leaf by valid JSONL append order, not
   timestamps. Ignore transaction-associated replacements without a commit.
3. Resolve a pre-compaction target through persisted display topology, following
   compact `logicalParentUuid` ancestry.
4. Derive a new retained model chain from that archival path ending immediately
   before the target. Exclude the abandoned compact boundary, summary, and later
   suffix, then pass the derived chain through existing resume normalization and
   state restoration. Never feed display projection rows directly to the model.
5. Preserve compact-boundary semantics instead of reconnecting summarized
   history into the ordinary model seed.
6. Return the active target, retained prefix, abandoned suffix, compact seams,
   reachable content replacements, and current head.
7. Distinguish the engine transcript identity from the desktop app-session
   address throughout the API.

Use this resolver for edit preview/edited-submit and fix `createFork()` in
`src/commands/branch/branch.ts` to fork only the authoritative active chain.
Branch must also require an idle turn and a durable transcript flush before
capturing HEAD. Tests must cover sibling leaves, compact boundaries, an
abandoned edit suffix, active-turn refusal, and resume of the resulting fork.

Make this resolver the common active-leaf owner used by ordinary resume, display
loading, edited replay, and Branch. The large-transcript
`walkChainBeforeParse()` optimization must become transaction-aware or remain
disabled until the committed leaf is known; it must not prune the last committed
fallback branch while an incomplete edit transaction exists.

### Durable input commit

Add an awaited engine-owned edited-input commit primitive. A plain replacement
message append is not enough: once written, latest-leaf resume can select it even
if the rest of the transaction failed. Introduce an append-only edit transaction
record with prepare, abort, and commit states:

1. Define closed versioned shapes for prepare, abort, and commit records, plus
   the replacement message's transaction association.
2. Terminal state is determined by the latest valid record for that transaction
   in JSONL append order, never by timestamp.
3. A durable prepare names the transaction, renderer operation ID, transport
   request ID, target, expected head, replacement UUID, scope, and engine-owned
   file rollback checkpoint.
4. The inactive replacement is appended and made durable with the prepare before
   any file is changed. Active-chain resolution and ordinary resume ignore it
   until a matching commit exists.
5. A handled failure before commit append begins restores transaction-owned
   files and appends a durable abort. Abort is never legal after commit append
   begins.
6. A readable valid commit is irrevocable and makes the replacement the active
   leaf. An abort cannot supersede it.
7. Once commit append begins, append, fsync, verification, or parent-directory
   sync uncertainty enters an `outcome_ambiguous` state. Do not run pre-commit
   rollback and do not emit ordinary success or failure. Keep session mutation
   blocked, reopen and reconcile under the session lock, and retry durability.
   If immediate reconciliation cannot establish a durable terminal state,
   report the typed ambiguous outcome and keep the session blocked for startup
   recovery.
8. Startup resolves an incomplete or ambiguous transaction before accepting
   another turn. It rolls back files only when they still match the
   transaction's applied fingerprint; if another process changed them, recovery
   preserves the newer content and reports a conflict.

The transaction record is additive persistence metadata, not a destructive
JSONL rewrite or a renderer-authored branch head. Use the guarantees of
`flushCurrentTranscriptDurably()` rather than treating `onInputPersisted` as the
commit point.

The existing transcript queues and file-operation chains are process-local.
Introduce one engine-owned cross-process mutation lock keyed by engine session
ID. Every main-thread transcript append, edit transaction/recovery, and Branch
HEAD snapshot must participate. The edit transaction holds it from expected-head
validation through terminal-state reconciliation. Branch also shares the
in-process edit/admission latch and rejects while an edit is open. Any new
workspace-shared recovery state obeys the existing single-writer, lockfile, and
atomic-write rules.

Transcript write APIs accept an owned lock guard so transaction appends reuse the
guard instead of trying to reacquire it. Define and test one lock ordering across
the sidecar admission latch, engine-session mutation lock, transcript queue, and
workspace fingerprint checks.

Reject the operation when session persistence is disabled. Test enqueue failure,
flush failure, fsync failure, UUID verification failure, process restart after
acknowledgement, and persistence-disabled mode. Add fault points after prepare,
inactive replacement, file apply, commit append, transcript fsync, commit
verification, and parent-directory fsync, including a large transcript above the
pre-parse pruning threshold with an incomplete transaction and older committed
head.

### Strict file-history transaction

Do not use the current best-effort `fileHistoryRewind()` or its preview helpers
as proof that a transaction can commit. Add a strict engine-owned operation that:

1. Fails closed when the target snapshot or any required backup is unavailable.
2. Preflights every target file before writing.
3. Captures enough current state to roll back already-applied writes and deletes.
4. Records preflight and intended-applied fingerprints for every path.
5. Compares the current fingerprint immediately before each apply or rollback.
   Never overwrite a path changed by another process.
6. Applies all transaction-owned changes or restores each still-owned path.
   Preserve concurrent modifications and return a typed conflict; the
   conversation remains uncommitted.
7. Returns structured changed paths, conflicts, and failures.

Preview must also distinguish zero changes from an unavailable or unreadable
snapshot. Tests must cover one valid and one failing file, rollback after a
partial apply, conversation-persistence failure after a successful restore, and
restart recovery of an incomplete prepared transaction.

### Human-takeover guard

Route every renderer-authored human submit, including an edited submit, through
the engine's `prepareHumanPromptAgainstDeferredContinuation()` operation before
starting a turn. Pending or ambiguous continuations are canceled atomically;
submitted or running attempts return a typed retryable failure. Engine-authored
task notifications do not use this guard.

Because that takeover operation is asynchronous, add a synchronous FIFO
human-submit admission latch at sidecar dispatch before the first await. It must:

- serialize ordinary and edited human submissions;
- preserve arrival order for mid-turn prompts;
- count pending admissions toward the existing queue-depth bound;
- block park, Branch, edit, and boundary drains;
- transfer ownership atomically to `activeTurn`, the bounded command queue, or
  the edit transaction;
- release on typed takeover refusal or validation failure.

Continuation cancellation completes before the prompt is announced as accepted.

## Phase 1: Canonical engine rewind capability

### Files

- `src/QueryEngine.ts`
- `src/app-runtime/createQueryEngineAppSession.ts`
- `src/app-runtime/createQueryEngineSessionController.ts`
- `src/app-runtime/AppSessionController.ts`
- Colocated focused tests

### QueryEngine API

Add narrow operations equivalent to:

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

Do not expose `mutableMessages` or a separately callable destructive apply step
through the app-runtime interface. Rewind and replacement remain one operation.
The edited operation owns one complete turn. It processes the replacement prompt
exactly once, commits that exact user-message UUID, invokes
`onEditedInputCommitted` synchronously, and then enters the query loop with the
already accepted message. It must not call the ordinary prompt
processing/persistence prefix again.

The preview operation should:

1. Resolve the target through the canonical persisted active chain, rehydrating
   the intended ancestry through the existing resume path when it precedes a
   compact boundary.
2. Validate it using the canonical operator-authorship predicate.
3. Identify the current active-chain head.
4. Return a revision token based on the current head UUID.
5. Return canonical resubmittable prompt content and associated input metadata.
   Collapsed-paste pills are renderer-local and cannot be reconstructed from the
   persisted prompt, so restore their expanded text rather than inventing
   placeholder metadata.
6. Count the suffix that will be removed.
7. Report whether the suffix contains non-synthetic messages.
8. Return the selected message's permission mode when present.

The edited-submit operation should stage the rewind internally:

1. Repeat target eligibility checks against current state.
2. Reject if the current head no longer matches `expectedHeadUuid`.
3. Rebuild `mutableMessages` as the canonical retained model chain immediately
   before the selected message. This may require reseeding from persistence for
   a pre-compaction target.
4. Restore permission mode associated with the target through the existing engine-owned app-state path.
5. Clear or recompute active-chain-derived state, including:
   - permission-denial accumulation;
   - context-collapse or compaction state;
   - context-window calculations derived from the removed suffix;
   - prompt suggestions or other continuation state that references the abandoned branch;
   - `readFileState`, conservatively or from retained read events;
   - `loadedNestedMemoryPaths`, conservatively or from retained context;
   - `AppState.fileHistory`, rebuilt from snapshots reachable through the retained
     chain using the canonical resume helper.
6. Preserve monotonic accounting such as cumulative API usage and incurred cost.
7. Return the retained head and canonical active-chain replay needed by the
   app-runtime layer.

### Persistence rule

Do not use `removeTranscriptMessage()` in `src/utils/sessionStorage.ts`. That helper physically removes an orphaned streaming entry and is not a conversation-rewind primitive.

The transcript remains append-only. The amended message starts a new parent chain from the retained branch point. The abandoned suffix remains historical data but is no longer reconstructed as the active conversation.

### Atomicity

A failed replacement submission must not leave the active engine conversation truncated while the renderer still shows the old branch.

Use one engine-owned transaction:

1. Acquire a synchronous per-session edit latch before the first await.
2. Validate the target and expected head.
3. When file restoration is selected, strictly preflight every file without
   changing the workspace.
4. Revalidate target and head after asynchronous preparation.
5. Process the replacement prompt once and stage the retained engine/AppState,
   exact replacement message, and canonical replay entirely in memory.
6. Append and durably verify prepare plus the inactive replacement before
   changing files.
7. Apply the preflighted file transaction with fingerprint checks.
8. Begin commit append. From this point, commit is irrevocable if readable and
   uncertainty follows the reconciliation path instead of rollback.
9. Flush, fsync, verify the commit and replacement, and sync the parent directory.
10. Swap in the already-staged engine/AppState with a non-failing state update.
11. Invoke the sidecar's synchronous committed-input callback. It updates the
    attach-time replay source and queues applied plus canonical replay before the
    query loop can emit assistant, tool, or permission output.
12. Before commit append begins, restore the prior engine state and every
    still-owned file on failure, then append abort. After it begins, reconcile
    without rollback until the terminal outcome is known.

The sidecar must not emit success at `onInputPersisted`. Success follows the new
durable commit primitive. The edit latch must block or fail ordinary submit,
park, queued-prompt drain, task-notification drain, permission handling, and a
second edit while the transaction is open. Edited submit and Branch must also
reject when the authoritative task domain reports running or pending work.
Revalidate live work before asynchronous preparation, after preparation, and
immediately before file application/commit. The latch prevents new task starts
while those checks and the transaction run.

### AppSessionController guards

The controller should reject both preview and edited submit when:

- a turn is active;
- a permission request is pending;
- the target is absent from the current active chain;
- the target is not an eligible user turn;
- transcript persistence is disabled;
- another edit transaction owns the session latch.

Edited submit must additionally reject when:

- the expected head is stale;
- a deferred continuation is already submitted or running;
- a running or pending background task exists.

Preview remains read-only and may report while background work exists, but its
expected head is only advisory; edited submit repeats every guard under the
mutation lock.

The controller should expose narrow preview and atomic edited-submit operations
through `QueryEngineSessionLike` and `AppSessionControllerAdapter`.

## Phase 2: File-history preview and restoration

### Existing engine machinery

Reuse the checkpoint formats and comparison/backup helpers behind:

- `fileHistoryGetDiffStats` in `src/utils/fileHistory.ts`;
- `fileHistoryHasAnyChanges` in `src/utils/fileHistory.ts`.

Do not use the result of either best-effort public operation as a strict preview
or transaction decision. Extract their low-level comparison and backup helpers
into strict engine-owned preflight/apply/rollback behavior beside them. Do not
duplicate file-checkpoint logic under `app/`.

### Preview result

The sidecar may return only bounded, non-secret facts:

```ts
type ConversationRewindFilePreview = {
  available: boolean
  filesChanged: number
  insertions: number
  deletions: number
}
```

Do not return file contents or renderer-authored paths.

### Apply scope

Accept a closed scope:

```ts
type ConversationRewindScope =
  | 'conversation'
  | 'conversation-and-files'
```

For `conversation-and-files`, invoke the strict file-history transaction against
the sidecar's real `AppStateStore`. Before commit append begins, preflight,
restoration, or replacement-persistence failure aborts the conversation edit and
rolls back every still-owned path. A concurrent file modification is preserved
and returned as `restoration_conflict`; it is never overwritten to manufacture
an all-files rollback claim. After commit append begins, use terminal-state
reconciliation and do not roll files back. Invalidate changed paths in
`readFileState`.

## Phase 3: Desktop protocol and sidecar boundary

### Files

- `app/shared/protocol.ts`
- `app/sidecar/sidecarServer.ts`
- `app/sidecar/sessionController.ts`
- `app/sidecar/sessionActionsDomain.ts`, or a dedicated adjacent domain if cohesion requires it
- `app/main/main.ts`
- `app/preload/preload.ts`
- Boundary, source-guard, and hardening tests

### Preview request

Add an app-local, strictly validated request:

```ts
type ConversationRewindPreviewMessage = {
  type: 'conversation.rewind.preview'
  requestId: string
  operationId: string
  targetMessageUuid: string
}
```

The fixed preload preview method accepts the renderer-minted `operationId` and
target UUID. Main adds the transport `requestId` before forwarding the request
to the sidecar.

### Preview result

Add a bounded result frame:

```ts
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

Define a narrower canonical editable-prompt snapshot rather than exposing a
broader engine prompt shape. It supports text and images already accepted by
the desktop composer, but no engine-owned objects. Persisted collapsed paste
metadata does not exist; return expanded text and test that no literal paste
placeholder is introduced.

Define `EditablePrompt` once as the existing bounded text/base64-image submit
subset. Locate the canonical type in the app-runtime contract and consume it
through type-only imports in the app wire contract. Use it in preview result,
renderer edit state, dedicated edited submit, and the QueryEngine edit API.
Keep strict boundary-local schemas in the web and desktop sidecars, with the same
text/image count and byte limits. Reject every other engine content-block
variant.

### Edited submit

Do not extend ordinary `app.submit.options`. Main currently strips unknown
options, the sidecar rejects unknown option keys, and the renderer cannot
correlate the main-minted submit request ID. Add a dedicated app-local,
strictly validated edited-submit verb equivalent to:

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

The renderer mints the bounded `operationId`; main continues to mint the
transport `requestId`. Both are echoed on every success or rejection so late
preview, applied, and error frames cannot consume a newer edit state. The
dedicated verb must be intercepted as app-local vocabulary before the shared
browser `app.submit` schema, so that schema is not widened accidentally.

After a valid `operationId` has been parsed, edit-specific rejection uses a
bounded result frame carrying both IDs, a closed error code, retryability, and a
redacted message. A generic `ErrorFrame` alone is insufficient because the
renderer cannot correlate its main-minted request ID. Malformed input rejected
before a bounded operation ID can be established may use the ordinary transport
error path.

The closed edited-submit result codes are:

- `stale_head`;
- `live_work`;
- `continuation_running`;
- `persistence_disabled`;
- `transaction_busy`;
- `restoration_conflict`;
- `durability_ambiguous`;
- `invalid_target`;
- `internal_error`.

`durability_ambiguous` is neither success nor ordinary rejection. The renderer
retains the pending draft, disables another submit for that session, and waits
for reconciliation or reconnect.

Expose a fixed preload method for this verb, not a generic sender. Add the
required fixed-channel, sender, source-guard, boundary, and hardening coverage.
The replacement prompt remains the ordinary bounded prompt content inside one
engine-side edit transaction.

### Applied result

Before replacement output is projected, emit:

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
```

An edited turn starts with the ordinary optimistic prompt announcement disabled.
After durable commit, the sidecar emits, in order:

1. `conversation-rewind.applied`;
2. a canonical reset-and-replay of the active display chain, including the
   replacement user message;
3. later assistant, tool, and permission output.

The applied frame and replay participate in normal sidecar/main buffering. A
renderer reload may first receive old buffered frames, but the applied frame
must reset them before the canonical replay, so it cannot resurrect the
abandoned suffix.

Build that replay through the same engine-seed plus archival-display pipeline
used by `app/sidecar/index.ts`, including compact-boundary alignment and restored
subagent history. Do not create a second mapper. Replace the sidecar's
attach-time history source with the newly committed replay before assistant
generation starts, so a later socket reattachment also receives the edited
chain rather than the startup-era branch.

The current attach-time history is immutable and broadcasts are dropped when no
connection exists. Make attach-time history mutable and track a monotonic
`historyGeneration`. Add an outbound-only `transcript-reset` control frame
carrying that generation:

```ts
type TranscriptResetFrame = {
  kind: 'transcript-reset'
  protocolVersion: typeof PROTOCOL_VERSION
  sessionId: SessionId
  historyGeneration: number
}
```

Retain the last terminal edit outcome's operation and request correlation in
memory and reconstruct it from transaction records on startup. Every connection
attach sends, in order:

1. ready and existing snapshots;
2. `transcript-reset` for the current generation;
3. the last matching applied or typed terminal-result frame, when one exists;
4. the current canonical history replay.

Both `transcript-reset` and `conversation-rewind.applied` reset projector and raw
log state unconditionally. Composer edit state clears only when an applied
operation ID matches. A reconciled abort or conflict re-emits its typed result so
an ambiguous pending draft can unlock without being discarded. This makes
commit-with-zero-connections, restart reconciliation, and later reattachment
safe.

### Boundary requirements

At the sidecar:

- use strict Zod schemas and strict-key checks;
- cap all strings and arrays;
- keep `operationId` bounded and correlate every response to it;
- validate the target against the live engine chain;
- treat renderer UUIDs only as selectors;
- derive prompt content, affected counts, permission mode, file snapshot, and head from engine state;
- reject stale heads;
- preserve inbound and outbound frame-size distinctions;
- apply the existing rate limiter;
- run outbound payloads through `secretGuard`;
- return typed, redacted failures without crashing the connection.

The protocol change is additive and should not require a version bump unless an existing shape must change incompatibly.

## Phase 4: Renderer state and projection

### Files

- `app/renderer/src/App.tsx`
- `app/renderer/src/composerState.ts`
- `app/renderer/src/transcriptProjector.ts`
- Adjacent state and projection tests

### Per-session edit state

Add state equivalent to:

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

The state must be keyed by desktop session ID. Switching tabs must not transfer an edit draft to another session.

### Edit flow

1. The user invokes **Edit sent message**.
2. If the row is a cached preview or parked session, restore it to engine-ready,
   then request the authoritative sidecar preview. Do not wait for a nonexistent
   replay-complete frame.
3. Enter edit mode directly only when the suffix is lossless and
   `fileChanges.available === true` with zero changed files. Unavailable preview
   is not equivalent to zero changes.
4. Otherwise show a confirmation dialog with:
   - **Edit conversation**;
   - **Edit and restore files**, when a checkpoint exists;
   - **Cancel**.
5. Populate the composer from the sidecar-returned canonical prompt.
6. Display an edit-state banner:

   > Editing an earlier message. Sending will discard later conversation.

7. Provide a visible **Cancel edit** action.
8. On send, include the target, expected head, and selected scope.
9. Retain the exact pending replacement text and images until the matching
   `operationId` is accepted.
10. Clear edit mode only after the matching applied frame.
11. On stale-head, continuation, durability, or restoration failure, retain the
    draft and show an actionable error.
12. Ignore late frames whose operation ID no longer owns the edit state.

### Projection truncation

`conversation-rewind.applied` must update the complete session projection and
raw-message log, not only visible rows.

The applied frame resets the addressed session's projector and raw-log state.
The immediately following canonical active-chain replay rebuilds:

- visible and hidden rows;
- seen frame IDs;
- message and content-block indexes;
- tool-use and tool-result correlations;
- streaming message state;
- grouped tool-run state;
- nested subagent joins;
- selector caches tied to the old row slice.

Do not rebuild from the existing raw-message log: it is independently capped,
retains the abandoned suffix, and ignores non-event control frames. Do not
manually slice every derived map. The sidecar's canonical reset-and-replay is
the authoritative rebuild source.

Batch tests must prove applied-before-replay ordering in both the raw-log and
transcript reducers. Tests must also prove that rewinding across tool calls does
not leave completed results attached to removed cards, orphaned pending cards,
removed subagent rows, stale streaming state, or duplicate-suppression entries
that hide the replacement message. Cover an evicted raw-log target, hidden
frames, tool-result-only frames, streams, nested agents, and
applied-plus-replacement in one frame batch.

## Phase 5: User-turn controls and confirmation UI

### Files

- `app/renderer/src/TranscriptView.tsx`
- `app/renderer/src/TranscriptView.test.tsx`
- Existing modal primitives such as `app/renderer/src/SAModal.tsx`
- Existing theme styles only where required

### User-turn grouping

One SDK user message can project into text and image rows. Add a read-time user-turn grouping keyed by the engine frame UUID so one sent turn receives one action surface even when it contains multiple content blocks.

Do not mutate stored projector rows to add UI state.

### Edit control

Every eligible top-level user turn should expose:

- an edit button visible on hover and keyboard focus;
- an accessible name of **Edit sent message**;
- keyboard activation;
- focus styling consistent with existing desktop controls.

The control must not be hover-only. It should become visible under `focus-within` and remain reachable in normal keyboard order.

Image-only user turns must also be editable.

Do not render the control on synthetic, task-notification, replay-only, hidden metadata, tool-result, or subagent user rows.

Edit activation on a restorable or parked row first restores the engine to
ready. Tests must deliberately use different app-session and engine-session IDs:
wire frames remain addressed by the app ID, while persisted-chain resolution and
resume use the engine ID.

### Session-level Rewind affordance

Do not immediately enable the disabled `Rewind…` item in `app/renderer/src/sessionActions.ts`.

After edit-and-resend is complete, either:

1. Rename the item to **Edit earlier message…** and open the same eligible-message picker; or
2. Define and implement durable no-resubmit rewind semantics before keeping the `Rewind…` label.

A menu label must not promise standalone rewind while only edit-and-resend exists.

The per-message edit control is a real-added surface. It does not close or
relabel the parity ledger's deferred standalone `RewindDialog` and picker rows
without a separate operator-approved adaptation.

## Tests

### Engine and app-runtime tests

Cover:

- previewing an eligible user message;
- rejecting unknown UUIDs;
- rejecting synthetic, metadata, tool-result, subagent, and task-notification messages;
- rejecting rewind during an active turn;
- rejecting rewind with a pending permission request;
- stale-head rejection;
- truncating immediately before the selected user message;
- permission-mode restoration;
- compact and context-derived state reset;
- preserving cumulative usage and cost while resetting branch-derived state;
- clearing or rebuilding read-file and nested-memory caches;
- rebuilding active `AppState.fileHistory` from the retained chain;
- abort or recovery when prepare, inactive replacement, or commit is not durable;
- durable active-chain reconstruction after resubmission;
- editing an operator message before a compact boundary;
- persistence-disabled rejection;
- deferred-continuation cancellation and running-attempt refusal;
- strict multi-file restoration rollback;
- sibling-leaf and edited-session Branch behavior;
- large-transcript transaction-aware pruning and fallback-head recovery;
- one replacement UUID in memory and JSONL, with prompt processing run once;
- fault injection at every prepare/replacement/file/commit/fsync boundary.

The persistence regression should exercise:

1. user A;
2. assistant A;
3. user B;
4. assistant B;
5. rewind to user B;
6. submit edited user B2;
7. reload from disk;
8. verify the active chain is A, assistant A, B2 and excludes the abandoned B suffix.

Repeat with user A before a compact boundary, user B after it, edit user A to
A2, restart, and verify both the display chain and model seed follow the edited
branch without reconnecting summarized history as live model context.

### Sidecar boundary tests

Cover:

- valid preview and edited submit;
- correlation by renderer-known operation ID;
- strict-key rejection;
- malformed, empty, and overlong UUIDs;
- stale target and stale head;
- attempts to target a non-user frame;
- conversation-only and conversation-and-files scopes;
- file restoration failure preventing conversation rewind;
- outbound secret screening;
- frame ordering: applied result before replacement message output;
- no assistant, tool, or permission frame before applied plus canonical replay;
- replay behavior after renderer reattachment;
- commit with zero connections followed by reset and canonical replay on attach;
- reversed preview-response order and cancel/re-enter ownership;
- persistence-disabled, deferred-continuation, durability, and transaction-latch failures;
- FIFO ordinary/edited admission across deferred-continuation awaits;
- live foreground-agent and background-shell refusal;
- different app-session and engine-session IDs.

### Renderer tests

Cover:

- one edit control per multi-block user turn;
- no controls on ineligible rows;
- keyboard accessibility;
- direct edit for a lossless suffix;
- confirmation when later messages or files are affected;
- cancel preserving transcript and prior composer draft;
- successful application truncating all derived state;
- stale-head errors retaining the edited draft;
- every typed edited-submit failure retaining the exact pending replacement;
- session switching preserving per-session edit state;
- text and image restoration;
- expanded-text restoration for an originally collapsed paste;
- cached-preview and parked-session restore-to-ready behavior;
- applied-frame reset of both raw-log and transcript state;
- attach-time generation reset into a renderer that still holds the abandoned branch;
- durability-ambiguous state retaining the draft and blocking resubmit.

## Verification

This feature touches both the engine and desktop areas. Run:

```bash
bun test <focused engine and app-runtime test paths>
bun run build:dev:full
bun test app/
bun run --cwd app typecheck
bun run --cwd app typecheck:sidecar
bun run --cwd app test:hardening
bun run --cwd app renderer:build
```

Also verify:

1. Remove the new closed-union projector case temporarily and confirm the TypeScript exhaustiveness tripwire fails.
2. Search source, tests, maps, configuration, Markdown, and migration docs for stale claims that desktop rewind has no engine seam.
3. Update `docs/maps/web-app-runtime.md` if ownership routes change.
4. Update the relevant `docs/migration/PARITY-LEDGER.md` rows.
5. Update only the owning migration row in `docs/migration/STATUS.md`.
6. Run operator-driven GUI acceptance for hover, keyboard focus, confirmation, cancellation, edited resend, file restoration, tab switching, and relaunch/resume behavior.

## Delivery sequence

Implement in independently verifiable slices:

1. **Engine transaction prerequisites**
   - Canonical persisted active-chain resolver.
   - Durable edited-input commit.
   - Strict file-history preflight/apply/rollback.
   - Human-takeover guard for desktop submits.
   - Cross-process engine-session mutation lock.
   - Transaction-aware resume/display/pruning owner.
   - Correct active-chain Branch behavior.

2. **Engine and app-runtime rewind seam**
   - QueryEngine preview and atomic edited-turn operations.
   - Controller guards, per-session transaction latch, and state reconstruction.
   - Single-pass edited-turn stream with committed-input callback.
   - Focused engine tests.

3. **Desktop sidecar and protocol boundary**
   - Strict preview and dedicated edited-submit vocabulary.
   - Fixed preload sender and operation correlation.
   - File-history integration.
   - Applied/reset/canonical-replay ordering.
   - Mutable generation-tagged attach history.
   - Boundary, replay, and two-ID tests.

4. **Renderer projection and composer state**
   - Raw-log and projector reset/replay reducers.
   - Per-session edit state.
   - Restore-to-ready, late-response, failure, and cancel behavior.

5. **User interface**
   - User-turn grouping.
   - Accessible edit controls.
   - Confirmation dialog and edit banner.

6. **Integration and migration bookkeeping**
   - Full engine and desktop batteries.
   - Exhaustiveness tripwire check.
   - GUI acceptance.
   - Map, parity-ledger, and status updates.

## Acceptance criteria

The feature is complete only when all of the following are true:

- An eligible sent user message can be selected from the desktop transcript and loaded into the composer.
- Canceling edit mode changes neither the active conversation nor persisted history.
- Sending an edited message discards the selected message and its dependent suffix from the active branch.
- Success is emitted only after the replacement and commit record pass the
  awaited flush, fsync, verification, and parent-directory-sync boundary.
- A readable commit encountered during a durability failure is irrevocable and
  enters typed reconciliation; it is never reported as an ordinary failed edit
  followed by file rollback.
- A stale conversation head fails closed without losing the edited draft.
- Every typed transaction failure preserves the exact edited draft.
- Optional file restoration reuses engine file-history formats through a strict,
  rollback-capable operation.
- Concurrent file writes are preserved and reported as typed conflicts; rollback
  never overwrites externally changed content.
- Reloading or resuming reconstructs the edited branch rather than the abandoned suffix.
- Messages before a compact boundary are editable through canonical persisted-chain reconstruction.
- Branching an edited or compacted session follows only the authoritative active chain.
- Renderer projection contains no stale tool, streaming, subagent, hidden-row, or deduplication state after rewind.
- The raw-message log and transcript projector reset from the same canonical replay.
- A reconnect resets stale projection state even if no client was attached when
  the edit committed.
- The sidecar strictly validates every new inbound shape and the hardening suite passes.
- The edit control is keyboard accessible and available for text, mixed-content, and image-only user turns.
- Cached-preview and parked sessions restore to ready before editing, without mixing app-session and engine-session IDs.
- Persistence-disabled sessions reject edit-and-resend explicitly.
- The full engine and desktop verification batteries pass.
