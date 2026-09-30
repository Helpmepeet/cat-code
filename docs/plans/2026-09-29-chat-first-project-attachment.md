# Chat-first project attachment

> The active agent-directed refactor is now specified in
> [Agent-directed workspace jump](2026-09-30-agent-workspace-jump.md).
> It replaces this document's pre-delivery intent-matching direction with normal
> conversational-agent judgment and a one-use jump capability. The historical
> implementation checkpoints below describe the architecture being retired.

> Manual saved or empty Chat → project → Move back → another project behavior is implemented
> and recorded in [CHAT-RELOCATION](../migration/decisions/CHAT-RELOCATION.md).
> The design-only authorization language and unverified list below are historical.
> Bounded automatic routing and its suggestion bar are now implemented for eligible managed Chats. The current implementation uses trusted known roots and conservative direct-work intent matching, with full-payload unsent/accepted/unknown recovery. Model intent classification remains deferred.

Revised 2026-09-29 after the third adversarial review. The design text below records that checkpoint; the later manual implementation is governed by the decision linked above.

## Implementation checkpoint, 2026-09-30

Pre-delivery routing now holds the full prompt/options durably, uses an observation-only trusted-root worker, moves a clear recognized project-scoped work request automatically, and asks about a plausible unique name match. Quoted/log/reference/negated evidence and ambiguous candidates do not authorize movement. Stay suppression permits later explicit requests. A project binding remains sticky.

Recovery distinguishes unsent, accepted receipts, and unknown handoffs. Restarts never automatically resend unknown messages; the bar exposes explicit recovery choices. The held delivery prepares the destination after a real host move, including when the manual host owner parks an inactive destination. Isolated process checks cover fresh and established Chats, trust refusal after classification, destination delivery, and recovery before and after movement. See the decision record for the implemented policy and limits. General exactly-once delivery, measured classifier accuracy, broad-language intent coverage, and Electron verification are not claimed. The product requirements below remain the target; the older unverified list records its original checkpoint.

## Implementation checkpoint, 2026-09-29

Manual Move now works before the first message and from closed or parked Chats. The host uses internal source/destination engine starts and a fresh identity-preserving startup for zero-turn histories; it returns closed Chats to a closed state. The relocation worker preserves metadata-only transcript files and companion artifacts. The first real submit runs in the destination context. Automatic routing of a held first message remains deferred. The original first-message feasibility warning below records the earlier design checkpoint, not the current manual Move limit.

The move notice identifies the latest directory transition and the current project/plain-Chat state. It distinguishes currently loaded instructions from former-project guidance retained in history or summaries, preserves applicable global instructions and user requests, and scopes a former project's instructions to work involving that project. Existing context loading and skill filtering remain responsible for the active instruction set.

The manual move keeps one app ID, one engine ID, one conversation, and the original Chat working folder through repeated project corrections. The saved history and companion output references move between normal history stores with lease protection, backup, a durable interrupted-move stop record, and compatibility links. Ordered transition anchors place the A2 divider inside the transcript. Closed child peers keep their project history without blocking Move back; active peer work and pending deliveries gate the move, and main rechecks project scope before forwarding or redelivery.

Auto, Fast, and Plan's return mode are captured from engine snapshots and restored through engine-owned transitions. The isolated real-process probe covers both project contexts, resume hooks, permission rules, skill discovery, idle wake, restart, Auto refusal and source recovery. A separate repeated-move probe covers old output references and compacted project-skill filtering. GUI behavior has not been checked because Electron was not launched. Earlier move records lack a durable transcript anchor, so their historical divider cannot be positioned exactly. The remaining automatic routing decisions and limits below are still open.

## Current direction

New conversations open as plain Chats. When a project applies, keep the **same Chat row, app session ID, engine session ID, and conversation history**. Safely stop the engine, relocate its saved session data to the destination's normal history storage, change the row to an ordinary project binding, and resume in that project.

**Message → project check → held send → safe stop → relocate history → resume → deliver once.**

History storage means the app's private per-project storage under its configured `projects` directory. Transcripts are not placed in the Git working tree. Chat-created working files remain in the private Chat folder unless the user asks to move them.

This supersedes the earlier requirement to keep the transcript at its original location while running elsewhere. It also supersedes the source/successor fork: there is one conversation, no copied history or model-written replacement summary, and no source row to retire. IDs stay the same across the transition; ordinary registry eviction/reopening rules are not being redesigned into a permanent app-ID guarantee.

**Why this candidate:** current registry lookup, resume, history discovery, and session artifact paths largely expect the active project's normal storage layout. Moving the saved data could preserve more of those assumptions than splitting storage from execution everywhere. This is a source-based hypothesis, not proof that relocation is cheap or correct. The first checkpoint must demonstrate relocation and return before building automatic matching.

- [Visual explanation](../design-html/2026-09-29-chat-first-project-attachment.html): one conversation; history relocation and engine restart.
- [Chosen move UI](../design-html/2026-09-29-chat-move-to-project-signal.html): **A2 · Bar**, authoritative for this surface. The diagram is not a competing UI.

## Matching before delivery

Minimize wrong automatic attachments while retaining useful coverage and asking infrequently. Zero false positives is an ideal, not a promised property.

Automatic routing runs **before the pending message reaches the working agent**. It receives the pending user message, relevant earlier user-authored messages, explicit session choices, and bounded project metadata. It does not receive tool results, assistant-generated summaries, project instructions, or fetched content as authority to move. Quoted or pasted text inside a user message still needs to be distinguished from the user's actual request.

Use deterministic name/path/alias lookup to narrow eligible candidates, with an LLM intent check where useful. That check is separate from the running agent's normal turn; its cost, latency, invocation policy, and exact implementation are unverified. Do not add an unconditional full agent turn to every send. A later suggestion from the working agent may offer the bar at a safe point, but cannot automatically relocate an already-executing turn or silently replay its prompt.

V1 proposed routing scope is explicitly eligible, existing projects with saved workspace trust, checked by the host again before spawn. Other projects require the ordinary explicit project/trust flow. History can suggest candidates but does not establish eligibility or trust. Model-facing project references resolve to host-validated canonical paths; a model cannot author an arbitrary spawn path.

| Evidence | Proposed result |
| --- | --- |
| Clear user request to work in one eligible, trusted project | Attach automatically before delivering the held message |
| Project work is intended and one plausible destination needs confirmation | Occasional A2 Bar |
| Several unresolved candidates | Stay unassigned; clarify only when necessary to do the task |
| General discussion, incidental mention, or weak similarity | Deliver in Chat quietly |

**Stay in chat** suppresses further inferred suggestions for that project in this Chat; a later explicit request can override it. Existing attachments are sticky: no automatic project-to-project hopping in v1.

Start with names, paths, and optional user-maintained aliases. Descriptions remain optional and should earn their maintenance cost through evaluation; their source is undecided. Candidate metadata is data, not instructions. Never load every candidate's CLAUDE.md to choose a project.

Use hand-labelled Chat-first requests, including later-turn intent, ambiguous names, reference-only repositories, quoted/negated paths, and general tasks. Historical project sessions are only supplementary: their prompts often omit the project because it was already selected. Measure wrong attachments on general chats, wrong destinations, correct coverage, prompts per conversation, and corrections. Do not treat an LLM confidence percentage as calibrated. Numerical launch thresholds are still undecided.

## A2 Bar and message handling

Preserve the chosen treatment:

- **Ask:** inline after the pending user message; project-blue folder icon, “Work in **cat-code**?”, bordered **Stay in chat**, pink-filled **Move**, pink tint, 12px corners. No AskUserQuestion card, paths, context inventory, or “Other project” line.
- **Moving:** same bar, “Moving to **cat-code**”, no buttons, left-to-right progress; composer uses “Connecting…”. Automatic matches skip Ask. Show progress only for an accepted transition; do not leave the bar indefinitely “Moving” while background work blocks it.
- **Moved:** thin blue project divider with folder icon, name, and undo arrow whose tooltip is **Move back**. The same sidebar row appears under the project. The held user message is delivered below the divider once.

**Recommended, not yet decided:** when a pre-delivery bar appears, keep the message pending until Move or Stay. Stay delivers it to the Chat; Move delivers it after attachment. This best matches the selected mock. The alternative is to run it in Chat immediately and apply any move only to later work. Resolve this before implementing the bar's send behaviour. Silence is not approval. Whether typing dismisses the bar remains open, as do Other-project placement and path-on-hover.

The existing connect/parked-send holding path is a reuse candidate, not a proven relocation queue. Persist enough pending-message identity and payload state to recover after a crash. Engine-ready does not mean input persisted. Do not claim general exactly-once delivery: distinguish unsent, durably accepted, and unknown outcomes; do not blindly resend an unknown outcome. A completed agent turn is never automatically repeated on attachment.

## Safe relocation and resume

The host owns the transition and both storage paths. The renderer and model supply only bounded intent/references. Before changing anything, validate the target and saved trust, preserve current user controls, and hold competing sends. Maintain exclusive transcript ownership during relocation as well as engine execution.

The stop boundary includes main-held work, not just the sidecar's queues. Gate new peer routing, outstanding wake operations, and ready-time redelivery while the association changes. Revalidate sender/recipient scope before delivery resumes; refuse or retain old-project work through its owner rather than delivering it into the new scope. Keeping the same app session ID must not bypass workspace boundaries.

Include deferred continuation jobs in the preflight inventory. V1 should refuse relocation while a job is pending, submitted, or ambiguous unless it has been explicitly resolved through its owner. Coordinate with scheduling through that owner; a one-time check is not sufficient if a job can appear during the move. Do not silently cancel or retarget scheduled work. The shared runner must also recognize the current validated association of relocated history when a later job is created; its existing first-entry cwd check is insufficient. Desktop exposure of every scheduling path is unverified.

For an established conversation:

1. **Obtain a safe stop.** Use a host-initiated relocation request reusing the idle-park checks, with an explicit success/refusal result. Active turns, pending permissions, workers, queued work, durable writes, and OAuth must be accounted for, together with the main-held work and deferred jobs above. Do not equate `restartSession()` with a safe stop: its current implementation signals termination and immediately spawns again. Wait for the old process to exit; its exit alone does not grant relocation ownership.
2. **Acquire relocation ownership and record the move.** Use the existing global engine-session-ID transcript lease, which is independent of cwd. Refuse without changing files if another process acquires it first. Persist the IDs, validated source/destination, original managed-storage binding, and the session artifacts being relocated before filesystem changes. The record must identify partial progress and the pending send; it is not a second transcript/history store. Hold exclusive ownership throughout relocation. Define how recovery and the replacement engine take ownership without exposing partially moved state to desktop or terminal resume; a host-local record alone does not protect terminal callers. This handoff remains unverified and must be resolved before real relocation is attempted.
3. **Relocate the session data.** Move `<engineId>.jsonl` and the associated `<engineId>/` data into the destination's normal history directory. Inventory and verify any other session-owned data before treating these two paths as complete. Validate destinations and refuse unexplained collisions. Two renames are not atomic together. Check filesystem assumptions rather than relying on “same parent”; an unsupported move must stop without an unchecked copy/delete fallback.
4. **Update association and restore.** Set the registry's cwd and ordinary project binding. Preserve the original Chat ownership record for return, but do not pass managed-mode restrictions into the project process. Have engine-owned persistence write the host-validated project association under the transcript lease and keep it discoverable by the fast history reader, following existing durable metadata conventions. The host relocates storage and validates association; it does not become an independent transcript-content writer. Resume with the same identities through normal project code, with the context-transition handling below. The move remains pending until association persistence is confirmed; its exact ordering with resume and the ownership handoff needs proof.
5. **Finish and deliver.** Verify the expected session identity, effective project cwd, and association; publish the divider/sidebar state; deliver the held message according to its durable delivery state. Revalidate held inbound work before releasing the transition gate. Normal project binding should enable normal project capabilities, including peer-name allocation, rather than inventing a partly-managed session type.

The first message is a separate case. If no conversation transcript or session artifacts exist, choose the project before initial delivery and use fresh startup. If an unassigned engine has already minted an ID, retaining it without a resumable transcript needs a verified identity-reuse path; do not assume the current restart supports this. If no engine ID exists yet, there is nothing to preserve. Startup hooks may have created state before a user turn, so “zero messages” alone does not prove there is nothing to move.

### Recovery and durable association

Do not use the transcript file's location alone as the source of truth for a partially completed move. Recovery must acquire exclusive ownership and reconcile the move record, transcript, companion artifacts, association metadata, and registry before ordinary registry reaping, catalog adoption, or engine spawn can act on them. A process crash releases a live lease eventually; competing resume paths must still recognize and refuse or recover an unfinished relocation before loading it. Handle interruption between each durable step, destination collisions, and unknown startup/delivery outcomes. Never silently resume a blank conversation or publish two writable copies.

History must retain the latest association after registry eviction and later reopen. Update the fast metadata reader and storage-directory-to-cwd mapping; old first-entry cwd/binding must not restore a moved session as managed or misgroup neighbouring project sessions. Revalidate the saved association through the host when opening; transcript metadata does not itself authorize arbitrary execution paths.

Relocating saved tool outputs can break absolute paths already embedded in the discussion. A compatibility strategy must be demonstrated; do not assume leaving a symlink solves permissions, history discovery, or reverse relocation. Private Chat working files stay where they are. Their relative references need explicit old/new folder context for the agent and validated absolute references when reused. Adding another working directory alone does not make `notes.md` unambiguous or justify broader permissions. Keep this detail out of the minimal A2 bar.

## Context, controls, and Move back

Use normal startup/resume owners for project instructions, settings, tools, skills/agents, MCP, memory, caches, and provider context. **Resume is not fresh startup:** established conversations run the SessionStart `resume` source; genuinely fresh sessions run `startup`. Do not execute both indiscriminately or promise startup-only hooks will run on every attachment. Check trust before either path, because the current desktop hook path can execute before the submit-time trust gate.

**A project transition needs more than ordinary resume.** Resume restores invoked skills from saved attachments as active guidance, preserves them through later compaction, and can suppress discovery of the destination's skills because an old listing exists. Preserve the raw conversation, but distinguish historical project material from instructions active in the new scope. Refresh destination skill discovery and prevent source-project skill attachments/state from being automatically reinstated or re-emitted as current instructions, including after Move back and another compaction. Preserve applicable user/global guidance. The exact provenance and replay mechanism remains unverified; do not claim that clearing process-local caches solves it or promise that historical text has been forgotten.

Preserve user-selected model and effort where valid. Preserve Plan mode and never silently increase permission scope. Destination rules and engine restrictions still apply. Existing restart does not carry all these choices, so the transfer must be explicit. The complete mapping of other permission modes needs a decision before implementation; do not inherit unrestricted bypass merely because it was active in Chat.

**Move back** uses the same safe stop and recoverable relocation in reverse, restores the original managed binding/private working folder, and resumes the current conversation. Suppress inferred reattachment to the rejected project. Refuse the transition while a recorded worktree is active unless an explicit, verified worktree-exit flow has completed; ordinary resume can otherwise restore the worktree and defeat the requested scope.

Move back does not rewind messages, erase project information already learned, undo edits, or reverse hook/external effects. Failed startup can also have effects; uncertain retries must not blindly rerun hooks. A clean new conversation remains a separate action.

Recommended, not yet decided: refuse moves while busy in v1, keep the held message recoverable, and leave the current association unchanged. Waiting and automatic retries can be considered later. Do not kill work or display endless progress.

## Verified source and contract changes

| Source | Evidence / limitation |
| --- | --- |
| [Host](../../app/host/host.ts), [supervisor](../../app/supervisor/supervisor.ts), [park gate](../../app/sidecar/sidecarServer.ts) | Restart can retain identities, but does not wait for exit. Idle-park checks active work and exits without the relocation acknowledgement needed here. |
| [Registry](../../app/host/registry.ts), [desktop resume](../../app/sidecar/sessionResume.ts), [session storage](../../src/utils/sessionStorage.ts) | Registry availability/reaping and desktop resume use cwd-derived transcript paths. Fast history metadata initially derives association from the transcript head. |
| [Transcript lease](../../src/utils/transcriptLease.ts), [desktop resume](../../app/sidecar/sessionResume.ts) | The global lease is keyed by engine session ID, independent of cwd. Resume acquires it before loading. Stopping one process does not reserve ownership for relocation. |
| [Saved tool results](../../src/utils/toolResultStorage.ts), [session memory](../../src/utils/permissions/filesystem.ts) | Session artifact paths can derive directly from cwd, independently of a pinned transcript directory. The earlier split-storage plan underestimated these owners. |
| [Managed storage](../../app/host/managedStorage.ts), [startup](../../app/sidecar/index.ts), [managed policy](../../src/utils/managedSessionPolicy.ts) | Ownership records and runtime binding are related but distinct. A managed spawn enables restrictions; project activation needs an ordinary project binding. |
| [History catalog](../../app/sidecar/sessionsCatalogDomain.ts), [sidebar catalog](../../app/renderer/src/sessionsCatalogState.ts) | Both current association and storage-folder mapping must survive history-only recovery. Moving bytes and changing the registry alone is insufficient. |
| [Hook trust](../../src/utils/hooks.ts), [resume hooks](../../src/utils/conversationRecovery.ts), [session configuration](../../app/sidecar/sessionController.ts) | Noninteractive hook execution bypasses the interactive trust check; resume/startup hook sources differ; model, effort, and permissions do not all restore identically. |
| [Skill restore](../../src/utils/conversationRecovery.ts), [instruction replay](../../src/utils/messages.ts), [skill listing](../../src/utils/attachments.ts), [compaction](../../src/services/compact/compact.ts) | Resume reinstates saved invoked skills as guidance and can suppress the destination listing. Compaction preserves invoked skills again. Ordinary resume alone does not establish the intended instruction scope. |
| [Peer request plane](../../app/main/peerRequestPlane.ts), [peer receiver](../../app/sidecar/sidecarServer.ts) | Initial targeting checks workspace scope. Main holds unacknowledged messages by app session ID and replays them on ready without repeating that check; parking refuses delivery so main retains it. |
| [Deferred jobs](../../src/services/deferredContinuation.ts), [runner](../../src/services/deferredContinuationRunner.ts), [resume coordination](../../src/utils/sessionRestore.ts) | Jobs retain storage/cwd/control values; the runner checks first-entry project identity; ordinary resume leaves pending jobs scheduled. Desktop exposure of every scheduling path is unverified. |
| [Worktree restore](../../src/utils/sessionRestore.ts), [composer hold](../../app/renderer/src/composerState.ts) | Resume can restore a worktree. Pending-send machinery exists, but its relocation and crash-recovery behaviour is unverified. |

These are static source findings. The competing-resume, stale-skill, cross-project redelivery, and stranded-job failure scenarios are inferred consequences of relocation and have not been reproduced at runtime.

Preserve **CLAUDE.md §§5–6**: renderer → preload → main → Electron-free supervisor → Unix socket → one engine process per session; raw events, distinct app/engine identities, receiver-side validation, and engine-owned permissions. Use [runEngineMigrations](../../src/migrations/runEngineMigrations.ts) for persisted migrations and the existing protocol/versioning process for new messages.

Proposed amendments, not edits to the existing decisions:

- [STARTUP-GATES G4](../migration/decisions/STARTUP-GATES.md): allow the same conversation to restart in another cwd, preserving per-path trust and one cwd per process.
- [HOST-REQUEST-PLANE HR3 / A2](../migration/decisions/HOST-REQUEST-PLANE.md): define the narrow host-authorized routing/relocation request and transition gating for routing, wake operations, and redelivery; existing peer verbs remain workspace-scoped after association changes.
- [IDLE-PARK](../migration/decisions/IDLE-PARK.md): reuse the engine's safe-stop conditions through a separate host-originated relocation contract with a result and exit acknowledgement. Do not turn renderer traffic into raw park authority or change automatic idle parking's semantics.
- [REGISTRY](../migration/decisions/REGISTRY.md): preserve its ordinary cwd-derived storage layout. Document relocation ordering/recovery before reap; a new persistent execution-folder/transcript-folder split is no longer proposed.

The pre-start trust gap is existing behaviour and deserves a separately scoped fix; attachment must not rely on the current submit gate to protect startup hooks. No unrelated code fix is authorized by this design update.

## Feasibility checkpoint and build order

**First prove relocation and return in isolated temporary storage, before implementing matching.** Use the real host/supervisor/engine lifecycle and production transcript paths for one managed Chat and one trusted project. Establish lease-protected relocation and recovery before moving real artifacts. Verify the same IDs, actual replayed messages, a saved large-output reference, correct instructions and hook transcript path, destination skill discovery, and fresh history-only reopening. Invoke a project skill, compact, return to Chat, and verify that source-project skills are not automatically reinstated as current guidance or preserved again as active skills. Interrupt between the transcript and companion-directory moves; verify recoverable ownership and refusal of competing resume against partial state.

This first experiment can exclude peers and deferred jobs, with that limitation explicit. No matching model, production UI, or broad migration is needed. It does not authorize enabling moves in sessions with those workloads. None of the open product choices below blocks this experiment.

The existing [lifetime-chain probe](../../app/host/lifetimeChain.probe.test.ts) is useful scaffolding, but its registry uses a sentinel `transcriptPathFor` that ignores cwd. A new relocation check must use real production path resolution against actual transcripts, not inherit that shortcut. It must fail when data is missing or association/path resolution is wrong; an echoed engine ID alone is not proof of retained history. Do not write test-only production APIs to manufacture success.

A successful round trip is only the first proof. Before enabling explicit Move/Move back, cover first-message identity, saved subagent artifacts, remaining partial relocation failures and ownership races, registry eviction, history/Branch reopening, trust rejection before hooks, mode preservation, worktree refusal, broken old output paths, and uncertain send outcomes. Verify that a peer message or wake arriving during the stop cannot cross the association boundary, and that unresolved deferred jobs block relocation while later jobs resolve relocated history correctly. These checks protect distinct transition risks, not repeated assertions at every layer.

Then build explicit Move/Move back and durable metadata/recovery with A2; only afterward add and evaluate pre-delivery routing. Specify router timeout/failure behaviour and measured wrong-attachment and interruption limits before enabling automation. If ownership, context handling, or old-path compatibility cannot remain contained, report the failing assumption and reassess instead of claiming relocation is already the simplest implementation.

**Unverified:** end-to-end relocation, cross-process ownership/recovery handoff, completeness of the session-artifact inventory, old-path compatibility, first-message identity reuse, runtime/context parity and instruction provenance, peer/wake isolation during transitions, deferred-job coordination and desktop exposure, crash recovery, hook retry behaviour, held-message persistence/delivery, router cost/latency/accuracy, and total implementation effort.

**Product decisions still open:** before feature implementation, settle holding the message while A2 awaits an answer (recommended), permission modes beyond preserving Plan/no escalation, and refusing busy moves for v1 (recommended). Before automation, settle router timeout/failure behaviour and measured launch thresholds. Other-project placement, path-on-hover, typing-as-dismissal, and alias/description maintenance remain open but do not block proving the transition. Saved trust is the proposed v1 prerequisite for routing; expanding to untrusted projects would need an explicit pre-start trust flow.
