# Chat relocation

Status: manual relocation is implemented for saved and empty managed Chats moving to a trusted project, back to Chat, and then to another trusted project. The implemented and reviewed 2026-09-30 agent-directed amendment below replaces bounded pre-delivery routing. Full-payload held-message recovery remains required. Direct automatic project-to-project moves are outside this slice. Isolated validation and remaining verification boundaries are recorded in the linked plan.

## Agent-directed amendment, 2026-09-30

The user authorized the refactor specified in
[Agent-directed workspace jump](../../plans/2026-09-30-agent-workspace-jump.md).
Every user prompt reaches the normal conversational agent. That agent uses its
full context to choose an initial workspace and invokes the jump capability;
there is no fixed intent policy and no separate pre-send model classifier.
Clear project mentions can select the project even for questions or incidental
mentions. Multiple mentions require clarification only when the destination is
ambiguous; a clear work target takes precedence over reference projects.

An unused managed conversation has one successful agent-directed jump to an
existing trusted project, under existing relocation mode restrictions. Retain
the jump tool's definition for cache stability after consumption, but make it
unavailable through agent guidance and receiving-boundary enforcement across
restarts, history reopen, and manual returns. Later project requests use ordinary
agent/file-access behavior without automatic context loading, another jump, or
a required new Chat. Existing manual relocation remains separately owned.
Fully settled operations permit later manual relocation by validating the latest
completed relocation record, both conversation identities, and original managed
binding before current canonical-path and saved-trust checks. Consumption remains
unchanged; unresolved operations still enforce their reserved endpoints.

The jump reserves the executing source turn, fences later effects independently
of provider retries, durably completes its paired tool exchange on the active
transcript chain, performs required cleanup, and suspends before parking.
An engine-owned handoff result distinguishes suspension from ordinary success
and retains source usage. Reservations guard turn admission and conflicting
conversation/location mutations; acknowledgements and cancellation remain
reachable. The existing lease, backup, interrupted-relocation refusal, identities,
process replacement, and destination context owners remain authoritative.

Destination trust/canonical identity are checked in the replacement process
before executable workspace configuration or hooks. A separately recorded
internal continuation uses the real controller and does not rerun the original
UserPromptSubmit hook or resubmit the user prompt. Admission and settlement are
durable; uncertain admitted work is not automatically replayed. Accepted failures
write a trusted terminal outcome through the engine, require user reconciliation,
and do not trigger a fresh automatic source attempt. Unresolved operations pin
registry rows before launch reaping. Cancellation before mutation prevents the
move; after mutation begins it suppresses continuation while filesystem
settlement finishes. Final durable location determines jump consumption.

An authenticated cancellation receipt proving the operation was never accepted
allows source-only terminal settlement after idle, with generation-bound host
tombstones preventing late acceptance. A timeout alone cannot release the hold.
The engine restores an unresolved terminal note's user-reconciliation gate from
active persisted history before goal scheduling, even without a jump ledger.
Interrupted destination results remain uncertain even when their error flag is
false. Terminal-note retries preserve the first selected outcome, and genuine
user reconciliation requires a durable verified input chain before its receipt.

Retire classification for new submissions and legacy resend. Preserve legacy
payloads, receipts, row retention, unreadable state, and explicit resend decisions
for unknown delivery. Certainly-unsent recovery delivers in the valid current
context. A completed legacy relocation is reconciled independently.

Because file-opening requests currently carry no message-origin identity,
relocated conversations temporarily refuse relative links. Absolute links in
the current workspace retain ordinary containment checks; no historical-file
authority is granted. The agent should emit absolute links after relocation.

The pre-delivery section below records the architecture being retired; its intent
rules, suggestion policy, and source reclassification are superseded by this
amendment. Its delivery-recovery invariants remain required. Source and the
validation record determine which amended paths have landed.

### Initial discovery and destination attachment, 2026-10-01

The [GUI follow-up](../../plans/2026-10-01-workspace-jump-followup.md) supplies
bounded recent workspace metadata to the first conversational request. A supplied
handle can go directly to `JumpWorkspace`; `ListWorkspaces` remains available
when the intended workspace is absent or unresolved. Discovery loads no candidate
instructions or files and leaves the destination decision with the conversational
agent. “Reply in chat only,” “plan only,” and “do not edit files” alone do not
prohibit workspace selection; an explicit instruction not to move does.

A restored destination reservation normally has no source handoff boundary in
its process. Attachment or idle may infer failure only for an operation locally
reserved by that source sidecar. Restored holds continue to gate turn admission;
explicit Stop and host-owned recovery remain authoritative.

Observation-only preview loading uses the completed relocation record's target
cwd, app identity, and canonical transcript path. It does not consume interruption
recovery state. Incomplete, unreadable, or mismatched records remain refused;
preview is neither a move nor a real resume.

## Contract

The session menu offers **Move to project…** for a saved managed Chat. Main resolves a one-time native directory-picker token, and the host validates the resulting real path. The destination must already have engine-persisted trust. The same `appSessionId`, `engineSessionId`, transcript, sidebar row, and original managed-folder ownership survive every move. **Move back** returns the working context to the original Chat folder; it does not rewind messages, files, hooks, or external effects. Chat-created working files stay in that folder. The model's desktop prompt names the original and current directories and explains how to interpret earlier relative file references. It grants no additional filesystem access.

An idle Chat may move while ready, parked, or closed. The host internally starts a parked or closed source through its normal restore owner, waits for its control snapshots, parks it, relocates it, verifies the destination engine, and parks the destination again. A closed Chat remains closed; these internal starts do not publish a tab-opening event or change focus. If no engine ID has been allocated, the normal sidecar startup allocates one before relocation. The host uses `app.park` and accepts only its dedicated parked exit. Active turns, pending permissions, queued prompts, workers, in-flight writes, sign-in, a concurrent branch switch, another move or restore, and a persisted worktree or deferred continuation block it. Peer sessions themselves cannot move. Retained child peer rows remain in their original project with their history; a child with active work, or a pending unconsumed peer delivery, blocks its parent's move. Closed children do not. Main's peer plane rechecks both live project associations before forwarding or redelivering, so old-project messages cannot enter the new context. Bypass-mode relocation remains outside this decision; classifier-backed Auto is supported.

## Pre-delivery routing

Historical implementation, superseded by the agent-directed amendment above.

Before a managed Chat submit reaches its sidecar, main durably holds the complete prompt and options in a private `desktop/project-routing.json` journal. A disposable, observation-only worker considers existing canonical project roots and filters them through engine-owned saved trust. It makes no model or account request and never loads candidate instructions. Main validates that a returned destination is one of its candidates. The renderer returns only a closed choice with app and submit IDs; it cannot supply a destination path.

The deterministic policy recognizes current direct work requests, not raw path presence. A unique project explicitly scoped by “in”, “on”, or “at” can move automatically; a unique project named in a work request without that scope asks first. Fenced/quoted evidence, log lines, reference or discussion language, negation, multiple candidates, and unrecognized prose stay in Chat. This is a deliberately limited English intent policy, not a general language classifier or a measured accuracy guarantee. Choosing Stay suppresses later inferred suggestions for that root in the same runtime; an explicit work request overrides suppression. Existing project bindings stay sticky. No candidates or classifier failure delivers in Chat. A relocation refusal retains the unsent payload and offers Stay or Cancel.

Automatic routing reuses the real host move and then `prepareRoutedSubmit`: an inactive source's successful manual move deliberately parks its destination, so the held-send path restores and waits for destination readiness and control snapshots before forwarding. Manual closed-session movement still leaves the Chat closed. The same app and engine identities survive. Preparation or transport refusal preserves certainly unsent input. If movement itself is interrupted, the separate relocation record still blocks unsafe resume; message recovery cannot repair half-moved history.

The journal atomically replaces a private file and synchronizes it before transport handoff. Checking, Ask, Moving, and preparation are **unsent** until handoff begins. Main persists **unknown** before calling transport, so a crash on either side of that call never triggers automatic replay. A matching sidecar `submit.result` persists an **accepted** receipt or returns the payload to unsent. Accepted receipts discard prompt/image content and suppress the most recent duplicate submit ID for that session. Acceptance proves admission, not a completed turn or independent transcript-flush durability. A missing receipt after 15 seconds or terminal connection loss exposes uncertainty.

After restart, unsent payloads offer Send or Cancel; Send rechecks routing if the Chat is still at its source, or prepares the recorded destination if the move already completed. Unknown payloads warn that delivery may already have occurred and offer an explicit Send again or Dismiss. They never resend automatically. Dismiss does not fabricate a delivery rejection. Resending an unknown outcome may duplicate a message. The full payload, including images, metadata, goal snapshot, and resolved file mention, is retained for recovery; only a text preview crosses the routing snapshot. Pending input protects its registry row from launch and bound reaping, including before engine-ID allocation. An unreadable journal is preserved and blocks submits until repaired. This protocol does not promise general exactly-once delivery.

## Storage, controls, and context

The disposable Bun worker holds the engine transcript lease, copies a private backup, and moves the JSONL and companion directory between normal per-project history stores. It also accepts a zero-turn Chat with no JSONL; an existing metadata-only JSONL and companion artifacts are preserved. It writes a durable `moving` record before renames and a `complete` record afterward. An empty record makes the next sidecar use the engine's fresh startup path with the same ID; that receiving boundary rejects an ID whose transcript already contains conversation messages. The registry separately records the first accepted input, even if the turn has no result, so a missing transcript cannot make that conversation look empty. The first real submit then materializes its transcript in the destination store. Compatibility links keep saved-output references from every former location usable, subject to the ordinary filesystem permission owner and explicit denies. Each completed move appends an ordered transition anchored to the last persisted display frame; the renderer shows the A2 blue divider at that boundary even after later messages or reopen. Moves with no intervening messages retain their order. A failed destination Auto restore uses a validated compensation move that removes only its attempted transition.

The move record also holds selected model, effort, Fast, permission mode, and Plan's engine-owned return mode. The host passes them on move, return, restore, restart, idle wake, and project-side history reopen, including before the first user message. The sidecar applies mode changes through engine transitions, checks classifier and Fast availability, and reports its effective snapshots before the host clears Moving. Auto refusal reports the engine's reason and reopens the source when possible. Invalid controls, including `null`, cannot be written. Fast is retained when the destination model and account support it; Plan entered from Auto retains Auto as its return mode. Later control changes refresh the record.

Destination instructions, settings, permissions, tools, skills, memory, and hooks come from a new engine process at the destination cwd. A move runs `SessionStart:resume`, not `SessionStart:startup`. Historical conversation text remains, while active resume filtering excludes invoked-skill attachments rooted in former workspaces and allows a fresh destination listing; global invoked skills remain. This filtering also applies after compaction and repeated moves. The sidecar's prompt identifies the latest source and destination and whether a project is attached. It explicitly treats former-project instructions retained in history or summaries as historical context, preserves applicable global instructions and user requests, and directs the agent to consult a former project's applicable instructions when working on its files. It also explains earlier relative paths without silently moving working files. This prompt guidance supplements the context loading and filtering; it does not erase historical text.

The lease and `moving` record block resume before transcript consumption or hooks. An interrupted or unreadable record keeps the row visible but refuses restore and preview. Recovery from an interrupted move remains manual from the saved backup; automatic repair and alias cleanup are outside this slice. A completed record reconciles registry and history association after row eviction, verifying the original app identity.

## Boundary and verification

Renderer input is limited to an app ID and picker token, or `null` for Move back. Main and the worker validate their closed requests; trust is checked before destination hooks. The isolated process probe `app/host/chatRelocation.feasibility.probe.test.ts` exercises the real host, supervisor, sidecar, worker, engine persistence, history resolver, two trusted projects, child-peer retention, Auto, Fast, Plan return state, idle wake, restart, destination instructions, hooks, skills, permission rules, saved outputs, refusal, and compensation without a model call. `app/shared/sessionRelocationRepeat.storage.test.ts` exercises repeated moves, old output paths, original working files, transition order, rollback, and compacted skill filtering through the real resume owner. The peer plane and renderer have focused boundary tests.

The isolated process probe now also exercises closed saved and live, parked, and closed empty Chats, ID allocation before ready, zero-turn artifacts, the first project submit with network blocked, and return before the first message. Renderer coverage checks the menu and picker cancellation. GUI behavior remains unverified because Electron was not launched. Records written before transition anchors were added cannot place their historical divider exactly; the renderer omits that old seam rather than displaying it after the entire transcript. Native file-picker tokens retain their ordinary five-minute lifetime across a move. Direct project-to-project moves remain deferred.


The isolated `app/host/projectRouting.process.test.ts` exercises the routing worker, real host relocation, parked-destination readiness, matching submit acceptance, destination transcript writes, established history, trust revoked between classification and movement, and recovery before/after movement. Every engine child uses temporary state and a network-blocking preload. `app/main/projectRoutingRecovery.test.ts` covers full-payload reconstruction across checking/Ask/Moving, admission and transport refusals, accepted receipts, unknown handoffs, lifecycle loss, explicit resend/dismissal, duplicate clicks, and unreadable records. Electron and GUI verification remain outstanding.
