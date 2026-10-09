# Workspace handoff lifecycle fix: implementation plan

Date: 2026-10-09 (Asia/Bangkok)
Status: Implemented; integrated production acceptance passes. Shared-checkout broad validation has unrelated blockers documented below. W/R acceptance gates durable-success publication. No saved-session repair, app launch, installation, or live model probe is authorized.
Intended repository path: `docs/reports/2026-10-09-handoff-fix-plan.md`.

### Implementation contract pass, 2026-10-09

The implementation starts at `07bb215c`; its transcript fixes are retained.
Pre-existing dirty paths are excluded. Engine owns QueryEngine, transcript and
checkpoint storage, execution records/migration, runtime/controller adapters and
their tests. Main owns workspaceJumpState, coordinator, control request owner,
main entrypoint, host predicates and workspace display projection. Sidecar owns
its server, startup/controller factory, entrypoint, supervisor and their tests.
The orchestrator owns shared protocol/evidence definitions, limits, replay
classification, cross-boundary acceptance, documentation and generated snapshots.

Concrete amendments:

- Snapshot gate includes `mode: held | review | open`; reservation and review
  fields alone cannot distinguish released review-only admission from open.
- Live release confirmation is scoped to observer generation. Historical
  converged evidence does not re-arm an operation after ordinary later edits.
  Unresolved attachments refresh current-generation gate confirmation.
- WorkspaceJumpState reads an explicit V1/V2 union. Main's conservative upgrade
  is persisted only on a touched transition. The immutable operation digest uses
  a fixed identity/location/boundary tuple with canonical binding keys.
- `app/shared/workspaceHandoff.ts` owns evidence types and strict validators.
- Engine API: configureWorkspaceHandoff, getWorkspaceHandoffSnapshot,
  startHandoffContinuation, cancelWorkspaceHandoff, settleWorkspaceHandoff,
  releaseWorkspaceHandoff, subscribeHandoffStatus. Continuation acknowledges
  durable claim with a separate completion promise. Sidecar checks exact main
  release authorization before applying the engine gate change.
- Verified async initialization precedes readiness, schedulers and admission.
  Awaited input commit and synchronous execution closure are internal callbacks.
- W applies storage logging transformations and reader selection. Final mutable
  assistant usage/stop fields can be updated only after body/provenance equality;
  missing or different content fails verification rather than becoming proof.
- The projection follows the existing enumerable JSON representation of a real
  SDK `system.api_error.error/cause`; this narrow documented logging transform
  does not permit arbitrary non-JSON objects or message-content substitution.
- `verify` checks the real source boundary without configuring an execution
  owner. Readiness fixes the immutable source-boundary digest before mutation
  commands may configure it. This prevents an accepted boundary-null tuple from
  becoming a conflicting admission identity.
- An ambiguous record replacement is re-read through a file and parent-directory
  sync barrier before it can be exposed as valid evidence. A sticky transcript
  writer error remains held/unconfirmed and never fabricates a warning or success.
- Settlement fences continuation before warning IO, coalesces duplicate calls,
  preserves an already-saved warning kind, and cannot replace durable success or
  re-arm review after genuine-input reconciliation. A failed receipt retry reuses
  the accepted input/context identities and rejects changed input content.
- Historical, converged receipts do not require the old prefix after legitimate
  later history edits. Unresolved recovery still verifies the bounded prefix.
  Normal initialization does not emit a handoff-release scheduler notification.
- A legitimate later source reservation retires a fully converged old helper
  only after its execution, settlement and record publications finish. Durable
  success, reconciliation or trusted historical convergence is required. Old
  release identities remain refused; configure identity checks remain strict.
- The per-session 32-state-frame limit also covers repeated connection
  attachments. A delayed observer can query status, and the bounded timer
  broadcasts the latest cumulative evidence after the window.

The supervisor-generation spoof and overlapping coordinator reconciliation
regressions have failed against their pre-fix owners for the intended reasons.
Success publication remains gated on real W/R acceptance, never mocks.

## 1. Verified baseline and scope

Initial inspection found `main` at `b8d5c79ab65dd67baad27abf338206e383300854`. During planning it advanced to **`07bb215c09f034181e81ceaf71f7569a84b29f7d`** (`fix(transcripts): preserve recovery ancestry and parallel history`). The final status is ahead 82, still dirty, with unrelated changes and nine changed paths withheld by the connector. The RCA remains unchanged from `b8d5c79a`; its full-file SHA-256 is `9e03e8c2f8654cfefa2b512d1748d69c2759a96ebeecd54106571673c1b42f89`.

Read `AGENTS.md`, `CLAUDE.md`, the workspace map, relevant desktop map entries, and the relocation, host-request, security, and permission decisions. Current source still has the 30-minute whole-turn request, rejection of reconciliation while `running`, and ignored release result. The existing controller, writer, and protocol contracts were inspected rather than inferred from the report. The final hash recheck confirmed the report, main, coordinator, sidecar, ledger, controller, and protocol snapshots. It detected the concurrent QueryEngine change; the relevant QueryEngine/sessionStorage patches were then inspected. That commit adds ordered recovery recording and recorder-promise waits and removes the unsafe pre-parser. It does **not** supply the checkpoint contract below. No correctness or test-pass claim about that separate commit is made here.

This plan repairs handoff coordination only. Do not redesign relocation, queue delivery, provider retries, transcript ancestry, or large-file pruning. Preserve canonical destination/trust checks, source-boundary validation, engine permissions, one engine process per session, Unix sockets, raw session events, separate app/engine identities, one-shot jump consumption, existing lifetime behavior, and unrelated work.

**Evidence limits:** the RCA reports isolated validation of timeout correlation loss, coordinator reconciliation rejection, and controller reservation consequences. It does not establish a full desktop/socket reproduction, release transport fault injection, or completion/cancellation ordering experiments. Those remain implementation validation requirements, not historical findings proved by this plan.

Current source anchors, relative to the repository:

| Contract | Inspected owner |
|---|---|
| Control expiry and release dispatch | `app/main/main.ts:4225–4235`, `4380–4390` |
| Result and admission handling | `app/main/main.ts:2033–2042` |
| Transition ownership and recovery | `app/main/workspaceJumpCoordinator.ts`, `terminal`, `move`, `reconcileUser`, `recover` |
| Continuation/settlement boundary | `app/sidecar/sidecarServer.ts:1820–1950` |
| Controller reservation/admission | `src/app-runtime/AppSessionController.ts` |
| Result versus persistence | `src/QueryEngine.ts`, inline recording and terminal-result paths |
| Durability and verification | `src/utils/sessionStorage.ts`, `flushCurrentTranscriptDurably`, `verifyActiveTranscriptTipDurably` |
| Wire shape | `app/shared/protocol.ts:948–976`; current protocol version is **2** |

## 2. Chosen repair and dependency contracts

**Use the existing main-owned jump ledger plus one bounded engine-owned execution record per accepted operation.** Add an operation-status exchange that carries both durable execution evidence and the current controller gate. Do not make a long-lived RPC the execution owner.

A transcript-only result marker was considered and rejected here: it would require handoff-specific retention through pruning, compaction, rewind, and forks before it could be a reliable independent completion receipt. A separate checkpoint log or database would add unnecessary machinery. The chosen record stores only bounded identity, outcome, and proof metadata; it is not a second transcript or an instruction source. Main continues to own authorization and coordination. The engine owns facts about execution and persisted input. Neither writes the other's store.

### Required contracts from the separate transcript work

These are integration contracts, not implementation plans for those fixes:

**W — sealed, ordered persistence.** The engine persistence owner must expose a `sealResumeCheckpoint(expectedResumeProjection)` operation. It waits for all required writes and final message mutations through the seal, detects append/queue/sync/ownership failures, durably flushes, and compares the actual restored conversation with the independently retained intended projection. It returns a checkpoint only on equality. It must preserve real tool-result contents, valid compaction transformations, and the intended branch, not just the tip. It must not force each streamed assistant block to await disk writing.

**R — deterministic bounded-prefix resume verification.** The corrected reader must read a fixed newline-aligned transcript prefix using normal resume selection semantics, including parallel recovery and valid compaction behavior, without allowing later records to affect that selection. It must expose completeness/error information and the same canonical resume projection used by W. No pruning-dependent selection differences, synthetic pairing substitutes, or silently truncated success are acceptable.

The handoff-facing checkpoint format is fixed:

```ts
type ResumeCheckpointV1 = {
  version: 1;
  prefixBytes: number;            // positive safe integer, complete JSONL prefix
  prefixSha256: string;          // 64 lowercase hex characters
  activeTipUuid: string;         // UUID
  projectionSha256: string;      // complete intended resume projection
  messageCount: number;          // nonnegative safe integer
};
```

`resume-projection-v1` means the complete ordered persisted engine-message projection after the storage owner's documented logging and compaction transformations. Canonical encoding sorts object keys, preserves array order and exact string/number values, follows JSON omission of undefined object fields, and rejects non-JSON values. It excludes storage-only envelope fields, not message content, provenance, restore flags, tool identities/results, or final usage. W and R must share that versioned projection contract; handoff code must not implement its own approximation. The expected digest originates from the engine's intended projection, not a second read of the same possibly-defective file.

The prefix digest fixes the exact bytes that passed verification; the projection digest verifies the reader's interpretation after restart. Neither digest is a substitute for W's initial independent comparison. Hash in bounded chunks; do not copy a complete transcript into the execution record. This versioned W/R interface is a required deliverable, not an existing function: a targeted search of the current QueryEngine and sessionStorage owners found no `sealResumeCheckpoint`. The newly landed recorder-promise barrier explicitly remains an enqueue barrier, not an fsync guarantee.

**Integration gate:** do not enable durable-success publication until W and R exist and their independent tests pass. Lifecycle protocol/state work can proceed against their explicit interfaces, but mocks cannot satisfy the final acceptance gate. An absent contract returns unavailable/unconfirmed, not success.

## 3. Authoritative execution record

### Owner, location, and identity

Add `src/utils/workspaceHandoffExecutionState.ts`. Only the engine process holding the session's transcript lease may write:

```text
<config-home>/workspace-handoff-executions/<engineSessionId>/<operationId>.json
```

Derive this path from validated runtime/ledger identities, never a wire path. Use a strict versioned schema, a 16 KiB serialized limit, private directories/files, no-follow regular-file checks, exclusive temporary creation, file fsync, atomic replacement, and parent-directory fsync. Validate size before parsing. Missing, malformed, identity-mismatched, and unreadable are distinct results. Malformed/unreadable must not become “never admitted.” Serialize writes for this operation and retain the prior valid record on failure.

The stable key contains `appSessionId`, `engineSessionId`, `operationId`, `continuationId`, `sourceGeneration`, `admissionGeneration` (null before destination admission), and `operationSha256`. Compute the operation digest from the immutable ledger identity, source/target cwd and binding, source boundary, and continuation ID. Use fixed-order JSON for that tuple. Mutable cancellation, completion, and release fields are excluded.

The supervisor must mint its generation **before spawn**, place that same value in the supervisor record and main-owned `CATCODE_SIDECAR_GENERATION`, and prevent caller-provided environment values overriding it. New operations require UUID generations. Legacy source-generation strings retain their existing bounded validation.

### Closed record schema

Besides `version: 1`, `origin: 'fresh' | 'legacy'`, and the stable key, the record contains:

| Field | Exact meaning |
|---|---|
| `revision` | Positive safe integer, increases after each successful durable replacement |
| `consumed` | The one execution attempt was claimed before entering the real continuation; never resets |
| `inputCommitted` | The continuation's own input, identified by `continuationId`, passed the input barrier |
| `cancellation` | Null, or `{cancelId, application, order}`; application is `prevented_start`, `abort_signalled`, or `too_late` |
| `terminal` | Null, or `{outcome, order, checkpoint}`; outcome is `success`, `failed`, `interrupted`, or `not_started` |
| `notice` | Null, or `{displayUuid, contextUuid, outcome, checkpoint}` for the existing engine-written terminal warning; outcome is `failed`, `cancelled`, or `uncertain` |
| `reconciliation` | Null, or `{noticeUuid, inputUuid, contextUuid, checkpoint}` proving a genuine input after that exact warning |

Except for the explicitly retained legacy source-generation string, identifiers are UUIDs; digests are fixed hex; enums are closed; nested objects reject extra fields. `order` is an operation-local engine ordering counter, not a timestamp. Receipt `revision` versions durable replacements; it is not the causal order of execution. Status observations have a separate process-local sequence because a gate can change without a new disk record.

Reject impossible combinations: successful terminal without fresh consumed admission, wrong generation/key, reconciliation without the matching notice, or conflicting terminal records. **Terminal outcome and its checkpoint are immutable once published.** Later cancellation disposition or reconciliation may extend the same record, never replace that outcome. Duplicate cancellation IDs return their first disposition. On replacement, start subsequent ordering above the largest persisted order; never infer an unpersisted historical abort or closure order.

For accepted source failures, `consumed=false`, `admissionGeneration=null`, and `not_started` are permitted only when the source/destination owner positively fences continuation. A durable claim followed by cancellation before invoking the continuation may instead have `consumed=true` and `not_started`; consumption is not proof that execution started. The checkpoint uses the ledger's verified current endpoint. A legacy-origin record can preserve warning/reconciliation evidence but can never mint a retrospective successful execution receipt.

No new automatic garbage collector is needed. Retain execution records with the existing jump/relocation recovery metadata; no age-based expiry while an operation may need recovery. Each record is bounded and each accepted operation has only one. This task neither scans nor repairs old sessions.

### Publication barrier

The engine's ordering is:

1. Claim consumption durably before invoking the existing continuation entry point. Reserve the in-memory admission slot before the first await, so duplicate commands cannot both claim it.
2. Persist the continuation input through the real QueryEngine path. Persist `inputCommitted` before publishing that fact or issuing a provider request.
3. Finish the actual query/tool/cleanup execution and freeze a terminal classification before awaiting the completion storage barrier. Classification uses the real terminal result, error/throw/interruption state, and unexpected-handoff checks, not operational `ok`, final-looking text, or a fulfilled adapter promise alone.
4. Seal W after final usage/stop-reason mutations. Keep the reservation and mutation/parking protections while sealing.
5. Persist `terminal` with W's checkpoint and fsync the execution record. Only now is success authoritative and publishable.

Add a narrow, engine-internal lifecycle observer through the existing QueryEngine/controller adapters: awaited input-commit notification and synchronous execution-closed notification. Keep these callbacks off renderer and shared SDK input schemas. Every continuation exit, including errors, limits, aborts, and throws, must reach the terminal classifier. Keep raw SDK events unchanged; a provisional SDK success must not be interpreted as this durable receipt.

Integrate execution closure **before** the new `pendingTranscriptWrites`/`settleTranscriptWrites` waits from `07bb215c`; a recorder failure is a durability failure, not evidence that model/tool execution failed. This requires an internal continuation-only completion hook covering every exit, not interpreting the wrapper promise after it throws. Cancellation fences synchronously even while admission storage is pending; recheck the latch after each barrier and immediately before invoking continuation/provider work. Serialize record replacements so pending admission cannot overwrite a cancellation fact.

The execution-closed latch is shared with cancellation handling. No new whole-turn timeout is introduced. A 30-second finalization watchdog emits a bounded diagnostic and an unconfirmed status, but does not cancel an outstanding write or authorize a concurrent warning writer. Only after outstanding writes definitively finish may the owner retry verification or settle uncertainty. A disk error, missing lease, failed checkpoint verification, or ambiguous receipt replacement never produces durable success. Re-read an ambiguously published record before selecting a warning. Never replay the turn to repair a storage failure.

## 4. Main ledger and status protocol

### Main-owned ledger V2

Keep the current immutable identity, source/target, acceptance time, movement phase, boundary, location, consumption, and compensation fields. `phase: settled` continues to describe movement; it no longer implies execution completion.

Replace the overloaded legacy continuation/outcome/cancellation/reconciliation fields with these closed groups:

```text
version: 2
revision: positive safe integer
origin: fresh | legacy
continuation:
  id, admissionGeneration (UUID or null)
  dispatch: none | unknown | consumed
  outcome: pending | success | failed | interrupted | not_started | unknown | legacy_settled
  receiptRevision (integer or null), checkpointSha256 (hex or null)
cancellation:
  null or {cancelId, requestedBy: stop | close,
           application: unknown | prevented_start | abort_signalled | too_late}
review:
  {required: boolean, noticeUuid: UUID or null, reconciledInputUuid: UUID or null}
release:
  {target: held | review | open, authorizedRevision: integer or null,
   confirmed: null or {generation: UUID, mode: review | open}}
legacy:
  absent for fresh records; original V1 outcome/continuation/cancellation/review flags
```

Do not persist transient `running`/`finalizing` observations on every status query. Keep those in the current-generation snapshot. Persist semantic transitions only. `consumed` at the outer level still means jump capability consumption; `continuation.dispatch` concerns execution admission.

`workspaceJumpRequiresRetention()` must include unknown dispatch/execution, pending warning/reconciliation, and an authorized release not confirmed for the current live generation. A successful receipt can set execution `success` while release remains pending. Only gate convergence releases the host reservation. Queue eligibility must use matched destination admission and actual live continuation activity, not the old `outcome: completed` admission shortcut.

### Wire changes

Bump `PROTOCOL_VERSION` from **2 to 3**: continuation acknowledgement semantics and result shapes change. Keep changes app-local; no new renderer sender or generic control channel.

`workspace.handoff` has `{requestId, operationId, forGeneration, action}` plus only the fields below:

| Action | Additional fields and behavior |
|---|---|
| `verify` | Existing `tipUuid`, `toolUseId`; retain source-boundary verification |
| `continue` | `continuationId`; acknowledge durable consumption, not turn completion |
| `status` | None; observation only, never starts a turn |
| `cancel` | `cancelId`; apply the main-ledger request to this operation only |
| `settle` | `outcome: failed | cancelled | uncertain`; replaces the three settlement action names |
| `release` | `authorizationRevision`; apply the current ledger's authorized gate target |

Remove the unused/redundant `reconcile` action. Replace `workspace.user-admitted` with **one** cumulative `workspace.handoff.state` frame, also emitted for admission, terminal publication, warning/reconciliation commitment, release, and attachment. Enrich `workspace.handoff.result` to include the action, a closed disposition (`accepted`, `already_applied`, `busy`, `refused`), a reason code when refused/busy, and the same status snapshot when identity is valid. Reasons are exactly `wrong_identity`, `wrong_generation`, `invalid_state`, `not_trusted`, `durability_unconfirmed`, `storage_unavailable`, `conflict`, or `rate_limited`; no free-form exception text crosses this channel. Both result and state envelopes retain `protocolVersion` and connection-bound `sessionId`; results echo `requestId` and `operationId`. Malformed frames use the existing bounded bad-request path.

The snapshot contains the stable operation/continuation identity; `observerGeneration`; increasing `statusSeq`; execution observation (`idle`, `consuming`, `running`, `finalizing`, `terminal`, `unconfirmed`); validated receipt metadata and its revision; and `{reservationOperationId: UUID|null, requiresUserReconciliation: boolean}`. A terminal/reconciliation proof carries its checkpoint metadata, never transcript text or a filesystem path. Record status is a closed union: `{kind: absent}`, `{kind: valid, record}`, `{kind: unreadable}`, or `{kind: invalid}`. A valid record contains only the schema in section 3. Absence is not synthetic success and cannot authorize replay after process replacement.

**Receiving rules:** strict validation in the sidecar and main; UUID/enum/integer checks; maximum 16 KiB per handoff snapshot/record-bearing frame; no coerced unknown fields; current connected app/engine membership; correct operation/continuation; main requests addressed to the actual spawned generation. Bound and coalesce handoff state processing to 32 frames per session per 10 seconds and at most one retained latest valid snapshot per operation. Preserve existing global transport/secret/rate bounds. A rate breach schedules bounded status recovery; it must not silently discard the only durable admission fact forever.

Main accepts a live snapshot only from the current supervisor connection/generation. On restart, the **observer** generation changes; the receipt's **admission** generation does not. A replacement may report old execution evidence only after the engine's restore verification below. Main validates shape and identity; it does not load or parse transcripts.

Classify both outbound kinds as main-consumed control data, not renderer-replay data. Update the protocol unions, strict-key tables, main-origin allowlist, exhaustive frame tables, and source guards together. Raw `AppSessionEvent` fidelity and permission ownership remain unchanged.

### Request expiry and convergence

Extract the existing pending-request owner into `app/main/workspaceHandoffControl.ts`, a production module used by main and integration tests. Use **20 seconds for all command acknowledgements**, including `continue`. Return transport outcomes separately from sidecar refusal/status; do not flatten timeout, disconnection, and explicit rejection into `false` execution failure.

A timeout deletes only request correlation. It cannot select a terminal outcome, append a warning, abort execution, or erase operation-level observations. Authenticated late results still feed the state observer even if their RPC no longer exists.

Query unresolved live operations on attach, timeout, relevant Stop/Close/submit attempts, and a coalesced 30-second timer. Permit one outstanding command per operation plus a pending cancellation priority slot; cancellation must not wait for a long continuation or storage operation. Preserve the 128-request global cap. Queries do not spawn parked engines, use credentials, or start model work. Stop polling converged/dead operations; resume recovery at the normal next attachment.

## 5. State transitions, reconciliation, and cancellation

### Main transition ownership

Retain `WorkspaceJumpCoordinator` as the sole ledger writer. Replace the whole-turn `running` critical section with a small per-operation transition inbox. Each transition reads current state, validates identity, writes the next state, and schedules an external effect. The effect's completion returns as another identity-tagged event. Do not hold the transition owner while awaiting the resumed turn or control reply.

Coalesce complete status snapshots by `(observerGeneration, statusSeq)`. A newer snapshot contains earlier durable notice/input facts, so it can replace an older snapshot safely. Never coalesce by dropping the input fact. Preserve cancellation intent independently when merging engine evidence. Recheck operation, generation, and intended effect revision after every await. Overflow retains the recovery-needed flag and triggers status reading, not successful settlement.

| Transition | Required action |
|---|---|
| Source accepted/ready/moving | Existing authorization, trust, cancellation tombstones, and verified relocation behavior remain |
| Destination ready | Main durably records generation and `dispatch: unknown` before sending `continue` |
| Consumption acknowledged/observed | Main records `dispatch: consumed`; no completed outcome |
| Real execution closes | Engine freezes outcome; main observes finalizing; reservations stay held |
| Verified successful terminal | Main saves success and an authorized open target; sends release |
| Failed/interrupted/unconfirmed execution | Preserve truthful outcome/uncertainty; settle warning only when idle and no finalizer can still publish |
| Warning persisted | Engine publishes warning proof, moves to review-only admission, then may drain the existing marked forced prompt |
| Genuine input committed | Engine publishes cumulative reconciliation proof; main clears review after processing it, even if settlement is still finishing |
| Gate confirmed | Main records current-generation gate state and releases host hold; this does not assert that unrelated work is idle |

### Reconciliation receipt and model context

Keep the existing engine-owned genuine-input eligibility checks. Enqueued input, meta prompts, peer/worker input, and automatic turns do not qualify.

For the first eligible input after the exact warning, append a fixed engine-authored meta context message saying that this user's input satisfies the warning's wait condition. Persist it with the genuine input through W, then persist the reconciliation receipt **before** clearing the controller gate, emitting the admission fact, or entering provider execution. Reuse message IDs on retries; do not create a duplicate prompt. Thread the awaited internal callback through the current adapter chain instead of relying on today's void callback for an asynchronous disk write.

Do not rewrite old warning text. This avoids breaking `findHandoffOutcomeInActiveTranscript()`'s exact legacy prompt checks and preserves history. The added context explains only the satisfied condition; it does not claim missing work succeeded or inject logs.

If input/context reached disk but the process died before the receipt, restore may recover the proof from the exact warning and genuinely accepted input in the verified active conversation, then save it. That clears reconciliation; it does **not** replay the input or certify that its response ran. Retain no-ledger source-cancellation reconciliation behavior.

The same-batch case is mandatory: a settlement result immediately followed by a newer admission snapshot is queued/coalesced and drained, never rejected permanently because settlement is busy. An older later-arriving settlement snapshot cannot re-enable a cleared review gate.

### Reservation release

A success receipt authorizes an open target only after main saves that target durably. The sidecar re-reads the exact operation and release authorization revision, verifies execution evidence, and applies release only to the matching reservation. A null reservation is `already_applied` only when its operation authorization and current gate agree. A different reservation is a refusal, not something to clear.

Map warnings truthfully: `failed` wording that says work did not continue is reserved for verified no-start failure; an independently failed admitted turn keeps execution `failed` but uses an `uncertain` warning about partial work. Confirmed interruption by Stop uses `cancelled`; unknown/interrupted execution without confirmed application uses `uncertain`. Preserve an already-durable warning rather than replacing its kind.

For warning settlement, keep the current combined behavior: persist the warning and its receipt first, release to **review-only**, then consider the marked prompt drain. Its status is also release evidence. Automatic and peer admission remain blocked until genuine reconciliation.

When release was not applied, status remains held and main retries the same authorized release. When only the reply was lost, status shows the gate already changed; main confirms without fabricating a failure. Confirmation is generation-specific and must be refreshed after replacement. Block rewind/fork/relocation and other destructive transcript mutations until convergence; normal append-only continuation after authorized release must not invalidate the sealed prefix.

Preserve current close behavior: an unresolved close records cancellation intent and returns the existing wait/close-again response; do not introduce background auto-close or change window/session lifetime. Once convergence is confirmed, the next close uses the ordinary host path. Do not report “closed” when only cancellation was requested. Existing queued-input, worker, persistence, and close protections still apply.

### Cancellation ordering

Main durably stores one operation-scoped `cancelId`; repeated Stop/Close coalesce, with Close retained as the latest requested action. While the handoff is retained, route Stop through the operation's `cancel` control, **not** through both that control and a delayed unscoped `app.abort`. Otherwise an old Stop could abort the next user turn after release. Outside handoff, existing abort behavior is unchanged.

At the engine execution owner, cancellation and execution closure use one synchronous latch:

| Engine ordering | Application / outcome |
|---|---|
| Cancellation fences admission before the real continuation is invoked, including while the claim is committing | `prevented_start`; `not_started`; delayed continue cannot run |
| Cancel reaches still-executing turn | Record `abort_signalled`; use existing abort/permission-denial machinery; actual terminal result determines interrupted versus independently failed execution |
| Execution has already closed, even if checkpoint publication is pending | `too_late`; never abort a later turn or rewrite frozen outcome |
| No trustworthy application/outcome survives process death | Unknown application/uncertain execution; no inferred success or replay |

Success requires the engine's successful terminal classification and W's durable proof. A successful SDK result alone, or an abort request alone, is not the outcome. Independent failures stay failures. Interrupted/partial execution still requires review and must never be relabelled success.

In particular: **freeze success → main records Stop/Close → cancel arrives → checkpoint becomes durable → completion reaches main** remains successful execution with late cancellation intent retained separately. Do not compare wall-clock timestamps or main arrival order. Conversely, cancellation that actually interrupts before terminal closure cannot become success because final-looking text already streamed.

## 6. Recovery and compatibility

### Lost delivery and process death

| Situation | Required recovery |
|---|---|
| Continue acknowledgement lost; same process reports consumed/running/terminal | Observe it; never submit again |
| Continue command not applied; same original process positively reports idle, no claim, no cancellation | Allow bounded redelivery of the identical control to that generation only; durable consumption plus the in-memory claim prevent duplicates |
| Status unavailable, malformed, or ambiguous | Keep hold and uncertainty; absence of a reply is not proof of non-admission |
| Process dies after main recorded dispatch but before a claim is observable | Replacement never continues that attempt; settle conservatively without replay |
| Dies after consumption/input, before terminal proof | No terminal success; preserve history and reconcile uncertain/interrupted work |
| Dies after terminal record fsync, before main settlement | Replacement validates record/checkpoint and reports completion without execution |
| Main dies after authorizing release, before confirmation | New observer validates unresolved evidence and converges the current gate |
| Release command lost / release reply lost | Distinguish held gate from already-applied gate through status; retry only the former |
| Admission notice lost | Recover cumulative receipt through status or normal restore |

Automatic redelivery of `continue` is forbidden across a process-generation change or after any consumption evidence. Direct duplicate commands to a consumed operation return status, never execute. A definitive no-start settlement durably fences the operation before writing its warning so a delayed command cannot start afterward.

On normal replacement startup, before automatic schedulers or prompt admission: validate registry/relocation identity and canonical current endpoint; recheck saved trust before executable project configuration as today; obtain the engine transcript lease; validate the record's operation and original admission identity; verify the checkpoint prefix bytes and the corrected reader's projection; then initialize the controller hold/review/open state and emit current-generation status. A receipt for another session, fork, operation, location, or admission generation is unusable. A new generation does not itself invalidate a matching old receipt, but it never inherits permission to rerun its attempt.

For an operation already durably converged in main, its receipt is historical evidence. Do not re-arm a handoff or reject legitimate later rewind, compaction, or manual relocation merely because the old prefix was subsequently changed by an authorized operation. Revalidate checkpoint content while recovering an **unresolved** execution; after convergence, use the existing current-conversation/relocation owners and current gate handshake. Do not use the historical receipt as a command to change active history.

### Existing V1 ledgers

Read V1 and V2 explicitly. Do not guess that V1 `completed + admitted` means success, and do not retrofit evidence from commits, assistant prose, or old operational `ok` records.

Unresolved V1 operations enter conservative recovery with continuation replay disabled. Existing exact warning and genuine-input evidence can still reconcile them. Preserve the original V1 flags in the bounded `legacy` field when main upgrades a touched ledger. Already-settled legacy conversations stay usable through normal restore; record `legacy_settled`, not newly verified success, and do not manufacture new warnings solely because old receipts do not exist. Retain genuine interrupted uncertainty, including the RCA's partial-execution case.

Register `migrateWorkspaceHandoffStorage` through `src/migrations/runEngineMigrations.ts` and advance the next migration version from the inspected **16**. It initializes/validates the new private engine-owned directory only. Main remains the sole jump-ledger writer and performs a backward-compatible on-write V1 upgrade under its existing ownership, not an engine-side bulk rewrite of host records. No migration changes transcript ancestry, old warnings, credentials, or running sessions. Unknown future versions fail closed and retain the registry row.

Protocol V3 requires matched main/preload/sidecar builds. Existing version checks reject mixed processes. Do not silently restart/kill live work to force compatibility; normal authorized app restart/deployment remains separate.

## 7. Practical implementation sequence and files

| Step | Work and owning files |
|---|---|
| 1. Lock contracts and fixtures | Update the handoff amendments in `docs/migration/decisions/CHAT-RELOCATION.md` and `HOST-REQUEST-PLANE.md`; add W/R contract fixtures at their separate owners. Verify their APIs before enabling publication. |
| 2. Persistence and compatibility | Add `src/utils/workspaceHandoffExecutionState.ts` and tests; extend `src/utils/workspaceJumpState.ts` with V2 validation/read compatibility/retention predicates; register the non-destructive migration. Test atomicity, bounds, identity, and failure behavior in temporary state. |
| 3. Engine execution ownership | Add a small `src/app-runtime/handoffExecution.ts` helper for the single-operation claim/closure/cancellation latch and receipt sequencing. Wire `AppSessionController.ts`, `handoff.ts`, `QueryEngine.ts`, `createQueryEngineSessionController.ts`, and `createQueryEngineAppSession.ts`. Keep ordinary-turn behavior untouched except required awaited internal hooks. |
| 4. Protocol and sidecar | Update `app/shared/protocol.ts`, `limits.ts`, strict schemas/tables and `app/sidecar/sidecarServer.ts`. Add the trusted generation in `app/supervisor/supervisor.ts` and consume it in `app/sidecar/index.ts`. Track the execution task independently from its acknowledgement. |
| 5. Main convergence | Add production `app/main/workspaceHandoffControl.ts`; update `main.ts` result/state handling, Stop/Close routing, and release tracking. Change `workspaceJumpCoordinator.ts` to short transitions plus tagged effects and retained cumulative observations. Update `app/host/host.ts` and `workspaceMoveDisplay.ts` predicates without adding renderer authority. |
| 6. Restore and reconciliation | Wire verified recovery before scheduler attachment in `app/sidecar/sessionController.ts`, `workspaceJumpStartup.ts`, and `src/app-runtime/createRuntimeBackedAppSession.ts`; use `app/sidecar/sessionResume.ts`'s existing lease/resume path. Preserve origin restrictions, queue/force/recall behavior, and no-replay rules. |
| 7. Integration and checks | Run the real-boundary regressions below, then affected package checks; regenerate owned snapshots with existing generators when their source interfaces change. Refresh only affected maps/decision references. |

Do not build a generic workflow engine, event bus, database, second queue, or independent resume stack. The new helper owns one operation; the existing coordinator still owns main transitions. New exports must be production interfaces, not test-only hooks. Stage only reviewed owned paths/hunks, and re-read shared files before writes/commits. No source work, staging, or commit was performed while preparing this plan.

## 8. Focused acceptance regressions

Use isolated config/workspace/transcript state, deterministic provider behavior, blocked networking, real production writer/reader for persistence assertions, and controllable time/delivery at the transport seam. Every regression must fail against the relevant pre-fix behavior for the intended reason.

| Boundary | Required regression |
|---|---|
| Real control owner + coordinator + sidecar/controller | Continue beyond the former 30-minute deadline, including a permission wait. Finish once, seal completion, converge release, and close. No timeout warning and no second execution. |
| Framing and main observation path | Deliver settlement result and the sidecar-produced durable admission snapshot in one decoder batch before prior promise continuations finish. Main ledger, controller gate, and restored state must agree. Repeat with order reversal, duplicates, stale snapshots, and lost notice. |
| Release transport | Drop release **before application**: next prompt stays protected, status says held, authorized retry releases. Separately drop **only its reply**: status says released, no false cancellation and no duplicate continuation. Test duplicate release and old-operation release against a different reservation. |
| QueryEngine + W + execution store | Independently fail assistant append, queued write drain, transcript fsync, directory fsync, read verification, and execution-record replacement/fsync. A provisional success/operational `ok` must never become durable success. Include delayed usage mutation and slow finalization. |
| Actual cancellation/terminal owner | Cancel before consumption; abort applied while executing; execution closes successfully before cancel but proof delivery is delayed; success closes before cancel during fsync; main records intent before closure but command reaches engine afterward; independent failure before cancel; crash after abort signal but before its durable record. Assert application, actual outcome, and main intent separately. |
| Real startup/lease and supervisor replacement | Death before dispatch, after dispatch but before claim, after claim/input, during execution, after terminal fsync, and before main release confirmation. No original-attempt replay; validate observer versus original admission generation. |
| Genuine-input admission | Forced queued input qualifies only after durable commitment; cancellation clears force marks without deleting queued content; recalled input does not reconcile; meta/peer/automatic input remains fenced. Crash between input/context persistence and receipt publication must recover without repeating the prompt. |
| Strict schemas and authority | Reject wrong app/engine/operation/continuation/generation, invalid digests/revisions, oversized/extra-key records, forged paths, conflicting receipts, and mixed protocol versions. Neither renderer input nor status queries may start or release arbitrary work. |
| V1 compatibility | Cover completed+admitted, interrupted/uncertain, already-reconciled, no-ledger source warning, malformed ledger, and already-settled legacy history. No invented success or repair. |
| Dependency integration | Use real W/R on parallel results, compaction, and complete intended history. Synthetic API placeholders, equal tips alone, or a mocked seal returning success cannot satisfy this test. |

Extend existing owners where possible: `src/QueryEngine.handoff.test.ts`, `src/app-runtime/AppSessionController.test.ts`, `app/main/workspaceJumpCoordinator.test.ts`, `app/sidecar/workspaceJumpBoundary.test.ts`, `workspaceJumpStartup.process.test.ts`, and supervisor/host tests. Add a focused `app/main/workspaceHandoffControl.test.ts` and one full handoff-lifecycle process integration test. Existing sidecar boundary tests script `runTurn` and persistence; they are useful schema/queue tests but not proof of the new durability barrier.

After focused checks, the implementation must run `bun run build:dev:full`, `bun test app/`, `bun run --cwd app typecheck`, and `bun run --cwd app typecheck:sidecar`, plus targeted engine tests. Avoid bare `bun test`. Investigate failures against the actual diff. Run docs checks (`git diff --check`, `bun run maps:lint`) after saving/editing repository documentation. Hardening, packaged-app, and GUI checks require separate authorization and are not part of this planning run.

## 9. Planning validation and readiness

Performed in this task: fresh checkout/status/history inspection; full updated RCA read and no-diff verification against `b8d5c79a`; final hash checks and narrow inspection of concurrent commit `07bb215c` in QueryEngine/sessionStorage; source inspection of control, coordinator, sidecar, controller, adapter, persistence, migration, startup, protocol, and existing boundary-test owners; and an isolated **abstract design model** with **14 permitted cancellation/durability/delivery orderings and 19 named assertions**, all passing.

The model checks proposed ordering, cumulative admission observation, release-not-applied versus lost-reply recovery, no-success-on-missing-proof, generation rejection, and no repeated consumption. It does not import or execute production TypeScript. It does not validate actual IO, fsync, sockets, process supervision, provider requests, or GUI behavior. It is design-consistency evidence only.

No repository suites, full desktop/socket reproduction, production release fault injection, production cancellation-order experiment, live model probe, app launch, or saved-session repair was performed. My Mac Files is read-only: the requested Mac path was not written. This Markdown artifact and the abstract model/results exist only in the conversation sandbox.

**Readiness:** the lifecycle design choices are resolved; no additional architecture decision is being deferred as an ordinary implementation detail. Implementation may start in the sequence above. End-to-end acceptance and durable-success enablement remain blocked on the explicitly scoped W/R checkpoint contracts and real-boundary regressions, not on re-implementing the separately landed ancestry/pruning changes. Saving the plan in the requested repository also requires a writable local tool; this session provides the plan as the requested fallback.


## 10. Implementation and production acceptance, 2026-10-09

Sections 1-9 above retain the original planning record and historical source
anchors. The implementation contract pass and this section describe the current
change, based on `07bb215c`, without repeating its transcript ancestry fixes.

The engine now seals and verifies independently intended complete resume
projections, records a single durable execution attempt, classifies closure
before persistence waits, and orders scoped cancellation separately from outcome.
Private atomic execution records synchronize the file and all directory links
needed to retain newly created storage. Replacement recovery verifies unresolved
proof and never replays consumption; an absent historical receipt cannot certify
that an old attempt never started. Genuine-input/context persistence and receipt
publication precede reconciliation and provider admission.

Main owns V2 coordination and conservative V1 upgrade, keeps late cumulative
evidence through command expiry, merges reconciliation without waiting for old
RPCs, and clears host retention only after current gate confirmation. The sidecar
acknowledges consumption independently of turn duration, enforces supervisor
generation and ledger release authorization, and protects pending persistence
from parking. Protocol V3 frames carry bounded metadata, remain main-only, and
are excluded from renderer replay. Ordinary initialization attaches schedulers
after recovery without manufacturing a handoff release or automatic goal wake.

Real cross-boundary acceptance uses the production QueryEngine, controller,
writer/reader, execution store, sidecar frame encoder/decoder, control owner and
coordinator with scripted providers and isolated blocked networking. It covers a
real permission wait beyond 30 minutes, settlement and genuine-input evidence in
one delivery batch, lost release command versus reply, a real completion fsync
failure, and exact parallel tool outputs after restore. Separate lease-owned
process fixtures prove replacement does not repeat continuation and historical
converged evidence survives legitimate later history changes.

The predecessor failures were re-derived at their actual owners:

- Main's old coordinator discarded genuine admission while settlement awaited:
  admission returned false and review stayed required.
- Supervisor accepted a forged caller generation before the generation fix.
- Pending warning persistence previously allowed parking.
- On tracked `07bb215c`, an early-fsynced real assistant resumed usage `0` and
  stop reason `null` despite final in-memory `91` and `end_turn`; the new seal
  checks and preserves those final values independently.
- Before retirement, all three successor-reservation cases paired the old
  operation snapshot with the new gate and failed; success, reconciled and
  historical ownership now retire safely.
- Before the attachment correction, 33 connections received 33 immediate state
  frames in one window; the same framed regression now receives 32 and later
  obtains the newest evidence through status/coalesced delivery.

The mandatory stable shared-checkout app run completed with 5,706 passing tests,
3 skipped, 16 failures and one error (5,725 tests, 382 files, 54,888 assertions).
Cold-import probes reproduce the independently isolated analytics metadata cycle
(`FILE_READ_TOOL_NAME` before initialization), and an ignored old `tmp/` archive
contributes an unresolved `accountsState.js` test import. These paths remain
untouched. During final verification, another chat committed its existing cleanup
as `1d9d61be`; none of its 57 paths overlap this task's owned paths. The analytics
metadata bytes are unchanged by that commit. The handoff commit preserves it and
`07bb215c`. A temporary snapshot of current tracked/owned source, restoring only
analytics metadata to `07bb215c` and excluding ignored archives, completed with
5,720 passes, 3 skips and one socket-readiness failure (5,724 tests, 381 files,
55,088 assertions). That empty-Chat rollback probe passes alone against both
clean baseline and implementation (25 assertions each); the broad timing failure
is not proof of an owned deterministic defect, and is retained as a validation
limit. After the bounded attachment and later-jump fixes, a fresh temporary
snapshot completed the full app suite with **5,722 passes, 3 skips, zero failures**
(5,725 tests, 381 files, 55,116 assertions). This verifies the handoff source with
baseline analytics metadata; it does not claim the unrelated analytics cleanup or
ignored archive in the shared checkout are repaired.

Final focused and package checks:

| Check | Result |
|---|---|
| Engine/checkpoint/controller/adapter suites | 54 passed, 285 assertions |
| Real cross-boundary control/engine acceptance | 6 passed, 67 assertions |
| Main coordinator/control/display/replay/supervisor | 94 passed, 284 assertions |
| Sidecar boundary/context and visible-text contracts | 27 passed, 171 assertions |
| Real startup/replacement processes | 6 passed, 67 assertions |
| `bun run build:dev:full` | Passed; 0 undefined names, 5,486-module bundle and CLI version check |
| `bun run --cwd app typecheck` | Passed |
| `bun run --cwd app typecheck:sidecar` | Passed; existing runner ignores 5,582 upstream diagnostics |
| `bun run --cwd app renderer:build` | Passed; bundle-size advisory only |
| Root engine typecheck comparison | 113 existing owned-path diagnostics versus 113 on `07bb215c`; zero added |
| Existing SDK generator | Already up to date; raw SDK interfaces unchanged |
| `bun run maps:lint`, `git diff --check` | Passed; 17 maps, 0 warnings |

The final process fixture creates its receipt by configuring the real runtime,
claiming continuation, invoking the scripted provider exactly once, and awaiting
real closure/seal/publication. After that process exits, the normal replacement
sidecar connects through the supervisor's Unix socket. Production main control
and coordination accept the durable success, persist release authorization,
receive the actual new-generation open gate, and clear host retention. A repeat
of the original continuation is refused without any new active turn. It does
not construct a terminal execution record directly. The historical case still
proves its old checkpoint rejects after a legitimate new conversation while
replacement remains open.

No app launch, installation, live provider request, saved-session repair, branch,
worktree, PR, or push was performed. Existing SDK generation reports its types
already current: these lifecycle callbacks do not change the raw SDK contract.
