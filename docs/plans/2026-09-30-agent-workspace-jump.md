# Agent-directed workspace jump

Status: implemented and reviewed; isolated verification complete.
The whole-plan review preceded implementation. Corrections include provider-attempt
fencing, mutation reservation, source-failure settlement, recovery retention,
typed suspension accounting, and cancellation before host acceptance.
Revised 2026-10-01 from the user's examples and isolated boundary checks.
This document supersedes the matching and automatic-routing design in
[the earlier attachment plan](2026-09-29-chat-first-project-attachment.md).
The active contract is described by
[CHAT-RELOCATION](../migration/decisions/CHAT-RELOCATION.md).
Commit `8f083a0c` only reduced the old router's visible flash and
worker launches; it is not the target architecture.

## User contract

Every prompt reaches the normal conversational agent. That agent judges whether
to invoke a workspace jump. There is no regex intent router and no separate
pre-send LLM classifier. A project mention is sufficient when the destination is
clear; an explicit switch command or proof that switching is necessary is not
required. Negation, references, and competing destinations are interpreted by
the conversational agent using its full context.

The user supplied these expectations, which guide agent instructions rather than
becoming predicates in application code:

| Prompt in normal Chat | Expected behavior |
| --- | --- |
| `What is cat-code?` | Jump to Cat Code, then answer. |
| `I worked on cat-code yesterday. Help me write an email.` | Jump to Cat Code, then help with the email. |
| `Compare cat-code and AgentVille.` | Ask which workspace to select because the destination is ambiguous. |
| `How does cat-code compare with VS Code?` where VS Code is not a known workspace | Jump to Cat Code, then compare. |
| `Use AgentVille's approach to improve cat-code's sidebar.` | Jump to Cat Code; it is the work target. |
| An explicit instruction not to jump | Honor the instruction through normal agent judgment. |

Only one successful agent jump is available per conversation. Keep its tool
definition stable for caching, but enforce consumed/ineligible state in the
receiving boundary and tell the agent to behave as though the jump capability
is gone. Do not remove the tool from the schema merely because it was consumed.
This preserves that part of the prompt shape, not a guarantee of whole-prefix
cache reuse across destination context loading.

After jumping, a request about another project uses ordinary agent behavior and
ordinary filesystem permission checks. It does not automatically load that
project as the session workspace, move again, create a conversation, or tell the
user that a new Chat is required. Reading another project's applicable
instructions as part of ordinary work remains ordinary behavior.

## Scope and existing owners

The automatic capability is for an unused managed Chat selecting an existing,
engine-trusted project. Already project-bound and project-created conversations
have no usable initial jump. Known project metadata is data, never instructions.
Unknown/untrusted destinations use the existing project/trust flow rather than
being created or trusted by this feature. Keep current mode eligibility,
including the existing bypass-mode relocation refusal.

Existing manual movement remains owned by the host. This feature does not add
automatic return, project-to-project movement, or an agent-composed
project-to-Chat-to-project workaround. Reopening, returning manually, or retrying
transport cannot reset a consumed agent capability. Existing relocated
conversations must be conservatively recognized as already attached when
eligibility is reconstructed.
After an operation fully settles, startup follows the latest completed manual
relocation record, verifying both conversation identities and the original
managed binding before current canonical-path and saved-trust checks. The old
jump destination must not prevent the supported manual project A → Chat →
project B sequence. Unresolved operations retain their stricter endpoint checks.

Keep Unix sockets, one engine process per session, raw engine event fidelity,
the app/engine identity split, transcript ownership, private backups, durable
relocation records, process replacement, replay, and destination context loading.
Working files remain in their original working directory.

Current owners:

- `app/main/main.ts`: normal submission and generation-bound handoff wiring;
  moving preserves acknowledgement and cancellation traffic.
- `app/main/workspaceJumpCoordinator.ts` and `src/utils/workspaceJumpState.ts`:
  operation admission, durable outcome, continuation, and recovery ownership.
- `app/main/projectRoutingController.ts`: legacy held payloads, delivery
  receipts, uncertainty, and direct resend without classification.
- `app/sidecar/workspaceListingWorker.ts`: observation-only saved trust lookup.
- `app/host/host.ts`: relocation gates, source park, replacement, reconciliation.
- `app/sidecar/sessionController.ts` and `desktopSystemPrompt.ts`: desktop tool
  registration and conversational workspace guidance.
- `app/sidecar/workspaceJumpTools.ts`, `workspaceJumpStartup.ts`, and
  `sidecarServer.ts`: caller checks, pre-hook startup validation, and source/
  destination turn controls.
- `src/Tool.ts`, `src/services/tools/StreamingToolExecutor.ts`,
  `src/services/tools/toolOrchestration.ts`, `src/query.ts`, `src/QueryEngine.ts`:
  tool execution and the query lifecycle.
- `app/main/peerRequestPlane.ts`, `app/sidecar/peerHostRequester.ts`,
  `app/shared/protocol.ts`: reusable agent-to-host request transport.
- `src/utils/sessionStorage.ts`, `sessionRelocation.ts`,
  `sessionRelocationState.ts`: durable transcript and relocation owners.

## Capabilities and authority

Provide a read-only known-workspace listing and a workspace-jump capability in
the desktop's ordinary engine tool pool. The listing does not load candidate
instructions, hooks, memory, or executable project configuration. Host-issued
opaque handles resolve through host-owned canonical mappings. A model-authored
filesystem path is never an execution destination. Revalidate handles, canonical
identity, eligibility, and engine-owned saved trust when executing the move.

The tool can affect only the requesting desktop conversation. Connection
identity establishes that conversation, while an engine-context check rejects
workers/forks before an operation is created. Hiding the tool from worker
discovery is insufficient because forks inherit tools.

Add closed, per-verb request authorization for these capabilities. Managed Chats
may use the new verbs without acquiring unrelated peer privileges. Preserve
peer workspace restrictions. Declare jump as a state-changing operation and
give the existing permission policy its resolved destination/effect; do not
inherit the empty Auto projection accidentally. Do not introduce unconditional
confirmation or a new intent classifier.
Ordinary permission policy may base-allow this action, as it does comparable
desktop host tools. The resolved projection is available when existing policy
routes an action through Auto classification; this feature does not force an
extra classifier call for every jump.

## Handoff protocol

Use one bounded durable operation per conversation, identified independently
of temporary transport request IDs. Bind it to source process generation,
conversation identities, destination identity, and a verified transcript
boundary. Keep pending reservation separate from filesystem `moving` state.

1. Reserve the source while its requesting turn is active. Refuse if accepted
   queued input, unrelated live workers/tasks, pending permissions, deferred
   jobs, or incompatible durable activity would be lost. All turn owners honor
   the reservation, including queued-input draining and goal-driven submissions.
   New input must retain its ordinary admission/retry behavior; never silently
   discard accepted input. A rejected operation releases its reservation.
   Reservation also serializes mutations of conversation state and location.
   Edit/rewind, branch, manual movement, restart, and conflicting runtime-control
   changes are refused while pending, or cancel/invalidate the operation
   durably before proceeding. Close/Stop follows the cancellation policy rather
   than bypassing coordination. Readiness is bound to the active transcript
   tip/chain and complete paired exchange, not the raw presence of UUIDs in an
   append-only file; discarded/rewound rows can remain physically present.
2. Main durably accepts or refuses the operation. Keep acknowledgement and Stop
   reachable; the existing blanket moving latch cannot guard pending control
   traffic. An expired request alone cannot later authorize movement.
3. Acceptance fences execution in both streaming and ordinary batch paths.
   Settle already-started effects, prevent later source calls, and emit paired
   skipped results for calls that will not execute. Nonconcurrency or prompt
   guidance alone is not a fence. Do not make another source model call.
   The accepted fence is turn-scoped and survives replacement of an executor or
   provider attempt. Streaming fallback currently tombstones yielded assistant
   messages, clears results, and creates a fresh executor (`src/query.ts`);
   after acceptance it must not erase the jump exchange or retry source work.
   Settle the ongoing response stream coherently, retain the accepted exchange
   and paired results for all observed skipped calls, and block fallback,
   reactive recovery, and auxiliary source model calls after acceptance. If a
   stream failure makes a valid durable exchange impossible, cancel/reconcile
   the pending operation and stop without moving.
4. Complete and durably verify the assistant/tool exchange, including skipped
   results. Require an owned persisted transcript; the current flush primitive
   can return without one and its single-UUID check is insufficient by itself.
   Perform mandatory turn cleanup. Represent this boundary as handoff suspension,
   not user cancellation or task completion: source Stop/TaskCompleted hooks
   must not restart source work. Normal computer-use unhide/cleanup still runs.
   Choose an engine-owned `SDKResultHandoff` (`type: result`, `subtype: handoff`)
   carrying the operation identity and the usual usage/accounting fields.
   QueryEngine emits this instead of ordinary success when suspending. Controller
   observers and goal accounting recognize suspension while retaining source
   usage; sidecar/main forward the raw event rather than inventing an app-side
   success/error result. Update SDK unions, projectors, and generated declarations
   together. The query's internal return reason also distinguishes handoff.
5. Finish source turn ownership and publish handoff readiness bound to the
   operation, process generation, and durable boundary. Only then park. Parking
   checks authoritative controller activity as well as sidecar state. A parked
   exit after cleanup timeout is not proof of transcript durability.
6. Reuse the existing transcript lease, relocation backup/record, registry
   update, process replacement, and effective-control verification. Determine
   location from the durable record, not the boolean host result. The replacement
   process must revalidate destination identity/trust before resume hooks or
   other executable workspace configuration.
7. Admit exactly one recorded internal continuation through the real controller.
   Preserve the original user message and transcript. Supply a trusted internal
   relocation outcome, not a model-written replacement summary or resubmitted
   user prompt. Use an explicit internal continuation entry with real engine
   trust/admission gates. It must not rerun UserPromptSubmit for the original
   user request: `isMeta` alone currently does not suppress that hook. Destination
   resume hooks retain their normal meaning. Reservation also prevents automatic
   destination turn owners from racing this continuation admission.

## Consumption, cancellation, and recovery

Persist consumed state so history reopen, process replacement, manual return,
and transport retries cannot re-enable a used jump. Consume based on a completed
durable destination outcome, even if reopening or continuation later fails.
Rejected/pre-mutation attempts do not consume it. If existing recovery performs
a verified compensation back to the source, record that outcome explicitly;
compensation does not undo destination hook effects.

An accepted/fenced operation that subsequently fails or is compensated writes a
trusted terminal failed/cancelled outcome in the surviving conversation through
the engine's persistence owner. Keep the pending tool result truthful: acceptance
is not a completed move. Expose that work did not continue, and do not start a
new model turn or retry the jump/original request automatically. Release the
execution reservation only after the terminal outcome is durable, while retaining
a requires-user-reconciliation gate against autonomous turns and row reaping.
Explicit subsequent user input/recovery reconciles that gate; a verified return
to source can leave the jump unused for a later request, not a retry of this one.
Do not pass raw operational logs or exception text into the model-facing outcome.
An admitted continuation that loses settlement has a distinct uncertain outcome:
some work may have started. Its note must not claim that no work continued.
Expose interruption and the need for user reconciliation in the ordinary UI;
a hidden internal transcript message alone is insufficient.

A timeout with an authenticated `not_accepted` cancellation receipt keeps the
source fenced until its engine durably saves the fixed cancelled outcome at idle.
Generation-bound host tombstones refuse a late acceptance of that operation.
This case has no accepted relocation ledger or invented destination. Missing
cancellation acknowledgements keep the hold. Reopening derives the outstanding
user-reconciliation gate from persisted terminal history before attaching the
goal scheduler; a later genuine persisted user turn clears it.

| Boundary | Required outcome |
| --- | --- |
| Refused before movement | Source and input retained; capability remains unused. |
| Stop before filesystem mutation | Cancel the pending handoff and suppress continuation. |
| Stop after mutation starts | Finish filesystem settlement; suppress continuation; do not kill between renames. |
| Incomplete/unreadable relocation record | Keep existing restore refusal and private-backup recovery. |
| Completed relocation, destination cannot reopen | Reconcile destination location and consumption; expose explicit restore without blind retries. |
| Continuation not admitted | Admission remains separate from movement; startup uncertainty must be resolved before retry. |
| Crash after continuation admission | Work is uncertain; never automatically resubmit the original request or admitted continuation. |

Record continuation identity, admission, and settlement durably. Operation IDs
prevent replay of an operation; the persistent one-jump limit also prevents
fresh agent-selected move cycles. This needs no general workflow system.
Only a successful destination result settles the continuation; a nonerror
interrupted result remains uncertain. A failed terminal-note acknowledgement
can retry the same selected outcome after idle, without changing its kind or
replaying work. Genuine input clears reconciliation only after its complete
active transcript chain is durably flushed and verified.

Load/reconcile unresolved operation state before registry launch can reap rows.
Include its app IDs in the existing retention predicate alongside legacy held
input; a failed destination startup can mark a row clean even though its
continuation remains pending/uncertain. Preserve and conservatively retain
unreadable journals, and block unsafe operation admission rather than erasing
them. Release retention only after the pending/uncertain outcome is explicitly
reconciled. Location reconstruction alone is not operation recovery.

## Retiring routing without losing recovery

Remove new-submit classification and obsolete intent rules/worker launch paths.
Preserve full legacy journal payloads, receipts, uncertain outcomes, and row
retention. Certainly-unsent legacy Send delivers directly in the current valid
context; it must not call `classifyHeld` again. Reconcile an already-completed
legacy relocation separately. Unknown delivery retains an explicit resend
decision. Do not delete unreadable journals or pretend unknown means unsent.

Retain existing relocation divider and association behavior. Historical relative
file links must not silently open a different file in the destination. The first
slice may fail safely for a former-workspace link; full historical openability
requires separately validated origin association and is outside the current
file-opening authority contract.
The explicit first-slice tradeoff is to refuse all relative file-opening links
in relocated conversations because today's request carries no source-frame
identity. Current-workspace absolute links retain ordinary containment checks.
Guide the agent to emit absolute links after relocation. This avoids editing
the other session's dirty TranscriptView and grants no historical-file authority.
Precise relative-link support can later add host-validated source-frame metadata;
do not claim that current destination relative links remain supported meanwhile.

## Contract amendments and implementation order

Amend CHAT-RELOCATION to replace pre-delivery routing with this agent-directed
one-shot capability and explicit handoff outcomes. Amend HOST-REQUEST-PLANE for
the new per-verb authority without relaxing peer rules. Preserve closed schemas
and protocol versioning: additive verbs may retain the envelope version;
breaking shapes require a version bump. Regenerate generated types from sources
when their owning contracts change. Persisted-state migrations use the existing
engine migration owner when necessary.

After the final review, the orchestrator assigns non-overlapping work in stages:

1. Engine execution fence, suspension/cleanup, controller admission, and durable
   readiness/terminal-outcome primitives with focused engine tests, including
   SDKResultHandoff and the explicit internal-continuation interface.
2. Durable operation/consumption state, host coordination, canonical/trust
   receiving boundaries, and transport/schema tests.
3. Desktop tools, instructions, source/destination wiring, and routing retirement
   with delivery-recovery regression coverage.
4. Orchestrator integration, deterministic process probes, generated types,
   file-opening fail-safe, contract/map updates, full affected checks, and scoped
   commit.

Each task depends on explicit shared interfaces agreed before parallel edits.
Agents preserve other sessions' dirty files and do not commit independently.
Avoid editing the already-dirty renderer transcript/composer files unless a
necessary integration is coordinated and their existing changes are preserved.

## Validation and authorization

The user now authorizes documentation updates, final review, and implementation
after review findings are fixed. They explicitly authorize delegated task-by-task
implementation. They do not authorize real-model evaluation, app/GUI launching,
live account probes, or installation. No need to ask permission again for the
authorized implementation or ordinary isolated verification.

Validate observable execution/admission/persistence behavior with scripted
model outputs and isolated temporary state, not an intent classifier. Cover
mixed-tool responses, reservation races, paired-result durability, stale process
readiness, fallback after streamed tool acceptance, late transport results,
worker rejection, trust revocation before
hooks, one-use persistence, cancellation boundaries, uncertain continuation,
and legacy resend without classification. Extend the strongest existing owner
tests instead of duplicating private implementation assertions.

Run focused engine/desktop tests, the dev-full build, desktop and sidecar
typechecks, renderer build if inputs change, map lint, and diff checks. Do not
run Electron hardening or GUI checks without launch authorization; report that
remaining verification boundary. Measure mechanical park/relocation/startup
latency in isolated no-model probes if practical. Timeout caps are not measured
normal latency. Isolated mechanical relocation samples measured 1,457 ms for a
live fresh Chat and 2,395 ms for an established inactive Chat, including its
warmup/repark. These are single samples of existing movement, excluding agent
judgment and continuation, not an end-to-end feature latency estimate.

## Implementation review, 2026-10-01

The requested implementation review used separate correctness/lifecycle,
contracts/security, specification, and execution lenses, followed by a tool-set
scenario review. The orchestrator validated findings before delegating fixes and
checked the resulting code and execution evidence. Nine valid findings were
fixed: four HIGH user-visible, three MEDIUM user-visible, and two LOW prose.
There are no deferred or inherited findings. One reported permission concern was
a false positive: ordinary policy can base-allow comparable host tools; the
requested change supplies resolved Auto input rather than forcing classification.

| Finding | Result and evidence |
| --- | --- |
| Invalid pending handoff continued past batch execution | Shared post-tool fence now stops auxiliary work and provider continuation; the regression fails before the fix and passes after. |
| Non-timeout failure could release a published or unknown acceptance | Host retains ambiguous reservations and the tool retains its invalid execution fence until authoritative settlement. Published acceptance and mixed-tool regressions distinguish the fix. |
| Interrupted nonerror continuation counted as success | Destination completion requires a successful result subtype; the receiving-boundary regression exercises both success and interruption. |
| Genuine input released reconciliation before durable storage | The actual engine awaits, fsyncs, and verifies the complete input chain before receipt. Blocked and failed FileHandle sync keep the hold and prevent provider admission; both regressions fail before the fix. |
| Settled ledger prevented later manual moves | Startup follows a fully bound completed manual relocation record after settlement. The actual Host/sidecar project A → Chat → project B probe preserves consumed eligibility and starts in B. |
| Terminal-note timeout could hold forever | Stop/recovery coalesce retries of the same selected fixed notice without replaying work. Timeout and lost-acknowledgement regressions fail before the fix. |
| Workspace errors incorrectly described disconnected peers | Tools now use bounded workspace-specific messages without raw host diagnostics. |
| Worker prompt invited a forbidden jump | Stable tool guidance now explicitly reserves selection for the main conversational agent; existing receiving guards remain. |
| Plan listed retired implementation as current owners | Current owner references and permission-policy wording were corrected. |

Final verification:

- Engine review focus: 64 passing tests, including actual storage barriers and
  scripted-provider execution fences. Scoped TypeScript comparison adds no
  diagnostics to the existing engine baseline.
- Host/plane/coordinator review focus: 203 passing tests.
- Desktop review focus: 13 tool/control, two pre-hook startup process, four real
  Host/sidecar lifecycle, and 69 sibling/source-guard tests passed. These totals
  overlap the full package suite and are not additive coverage counts.
- Final `bun test ./app/`: 5,216 passed, three existing skips, five baseline
  renderer failures, zero runner errors; 5,224 tests across 359 files.
- `build:dev:full`, app and sidecar typechecks, and renderer build passed.
  Map lint passed with 17 maps and zero warnings; all 113 local documentation
  links resolved, and diff whitespace checks passed.

The full desktop suite's five renderer failures were also reproduced against
archived HEAD renderer/shared sources. Their mechanisms are untouched by this
feature; the other session's dirty renderer files were preserved. Root engine
TypeScript has inherited diagnostics; scoped comparison found no new diagnostics.
The baseline failures are the App CC-16 drain, foreground-subagent, and D5
refused-submit source tripwires, the memory waiting-state literal, and the unread
permission-settings literal. No task code depends on the failed literals.
The deleted policy/runner tests cover retired classification, with legacy resend
recovery still tested. No tests were newly skipped or weakened, dependencies
added, or build/CI/agent-rule configuration changed. The feasibility fixture uses
the existing injected Host clock to separate independent lifecycle scenarios
from the production spawn-rate cap, whose own tests remain unchanged.

Four effects remain unproven in this pass; these are verification boundaries,
not deferred defects:

| Effect | Exact follow-up verification |
| --- | --- |
| Live-model destination judgment | In an authorized Cat Code Dev run with isolated state and unused managed Chats, send clear project, explicit do-not, and ambiguous competing-project prompts. Observe jump, stay, and clarification respectively, then confirm one successful jump and ordinary later project behavior. Scripted-provider tests cannot establish intent sensitivity. |
| Complete new agent-to-main transport composition | In an isolated integration harness, send scripted JumpWorkspace through the real supervisor socket and main request/control wiring, then verify relocation, destination continuation, cancellation, and original prompt stored once. Current real process tests exercise mechanical relocation; separate owner tests exercise the new controls. |
| GUI presentation and OS file opening | With Dev GUI authorization, inspect retained row identity/history, click an old relative link to confirm refusal, and click a current absolute link to confirm normal opening. Current tests exercise the host filesystem boundary with an injected opener. |
| Older installed transcript writer | Identify its actual build commit and exercise its load/write logic on a copied transcript containing the new outcome subtype under isolated config. Confirm metadata preservation. This task neither identifies nor launches that writer and does not modify live transcripts. |

No Electron/GUI or installed app was launched, no real model/account probe ran,
and no dependencies were installed. Actual process checks used temporary state
and tracked child processes. Filesystem relocation and transcript durability are
tested against their real owners; OS crash/power-loss behavior is not simulated.
