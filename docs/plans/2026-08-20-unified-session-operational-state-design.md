# Unified Session Operational State Across TUI and Desktop

**Status:** design proposal, 2026-08-20

**Evidence report:**

`docs/research/2026-08-20-current-upstream-session-activity-comparison.md`

## Objective

Define one framework-independent rule for answering whether a Cat Code session is
working, waiting for the user, idle, or unavailable, then make each surface adapt
that result to its own controls and presentation.

The design covers:

- the terminal UI in `src/`;
- runtime-backed sessions in `src/app-runtime/`;
- the Electron desktop renderer and host lifecycle in `app/`;
- terminal tab status, process-list activity, desktop tabs, composer behavior,
  abort controls, and idle parking.

It does not change the locked desktop topology, raw `AppSessionEvent` fidelity,
two-id model, Unix-domain-socket transport, or renderer trust boundary.

## Executive conclusion

The current systems have good low-level facts but no shared operational
projection.

- Cat Code and current upstream Claude Code 2.1.237 use materially the same
  `QueryGuard` state machine. Current upstream is nevertheless ahead around the
  guard: it owns turn state in a dedicated external-store controller and its
  exported status includes more visible blockers, delegated work, and shell
  activity.
- The runtime emits authoritative, separate turn, permission, and abort events.
  That separation is correct and should remain.
- Desktop keeps lifecycle, turn activity, permission queues, queued prompts, and
  abort state separate, but presentation code combines only subsets of them.
  This creates simultaneous readings such as `generating`, `Waiting for
  approval`, and composer-enabled.
- A single mutable status field would make this worse. Lifecycle, work, blockers,
  and capabilities are orthogonal. The shared artifact must therefore be a pure
  deriver over facts, not a state owner.

The canonical precedence is:

```text
unavailable process/connection
  > waiting for user
  > working
  > idle
```

`parked` is not a dead/disconnected failure. It is an intentional, restorable
idle lifecycle with no live engine. Presentation may say `idle`; capability
adapters must restore before sending and must not expose Stop.

## 1. Evidence boundary and upstream provenance

### What this repository can prove

The repository has one configured remote, the Cat Code fork at `origin`. It has
no Anthropic/upstream remote or upstream-tracking ref. Its object graph contains
two disconnected root snapshots:

- `f66f3ab7b5d918b9f3b999bd1be3fefd3330ea41`, dated 2026-04-01;
- `86051a8e52de68d8272411ccd9cbdc42a1260e4f`, dated 2026-04-30.

Both roots already contain `QueryGuard` and the comment that it replaces the old
`isLoading` plus `isQueryRunning` pattern. The pre-`QueryGuard` implementation
and its transition commit are not present. The old design below is therefore
reconstructed from surviving comments and from the invariants enforced by its
replacement. It must not be reported as an exact historical diff.

Current upstream behavior was separately verified against the official
`@anthropic-ai/claude-code` 2.1.237 npm artifacts published 2026-08-19:

- wrapper tarball SHA-256
  `94253aceefc12d015b7889932d1707c8af74ca839b876bda8cadfc3e4f3a7333`;
- Darwin arm64 package SHA-256
  `c5978b8e6549bdf39130e53404a88dc259724bed8ac49c82ee87f8cd231ed5a8`;
- unpacked native executable SHA-256
  `338901351d4ff17495738c67fc3e12a32c1b506738ac5e012eb782d3d8b5be43`.

The published application is a minified Bun native bundle without source maps.
Its behavior can be identified from bundled state transitions, strings, and
call relationships, but its minified symbol names are artifact-local and cannot
be treated as stable source APIs.

### Current upstream versus Cat Code

Current upstream's minified QueryGuard has the same three states and transitions
as Cat Code:

- `idle -> dispatching` through `reserve()`;
- `dispatching -> running` and `idle -> running` through `tryStart()`;
- generation-safe `end(generation)`;
- generation-invalidating `forceEnd()`;
- `isActive` and `isRunning`.

There is no evidence that upstream has a newer four-state guard or stronger
reservation ownership. Cat Code's guard is better instrumented because it logs
blocked and successful transitions.

Current upstream is better in the surrounding architecture:

1. A dedicated external-store turn controller owns QueryGuard, external loading,
   abort state, timing, stream state, submit count, completion time, execution,
   and cancellation. Cat Code still assembles those concerns inline in
   `REPL.tsx`.
2. Upstream derives `working` from the main local query while deriving aggregate
   `busy` from loading or delegated activity. Waiting overrides both.
3. Upstream waiting classification includes worker sandbox prompts, MCP
   elicitation, mapped top-dialog blockers, worker requests, sandbox requests,
   and local interactive dialogs.
4. Delegated activity includes active local agents, remote agents, in-process
   teammates, and local workflows, with exclusions for terminal tasks, idle
   teammates, and deliberately long-running remote agents.
5. Active local shell tasks export a distinct PID status, `shell`.
6. PID records preserve `statusUpdatedAt` independently from ordinary updates
   and use process-start identity to protect against PID reuse.

Upstream's top-dialog mapper falls back to `permission prompt` for registered
permission kinds without a specific mapping. Identifiable Bash, file, WebFetch,
Skill, PowerShell, browser, monitor, plan-mode, peer-approval, and auto-mode
permission dialogs therefore still produce waiting. Cat Code's explicit
`toolUseConfirmQueue` and `promptQueue` checks remain useful because they retain
richer request detail such as the tool name.

Confirmed later Cat Code changes include:

- `5bf2e6f304be0a2f01783130823d7645d2cd256d`, which added QueryGuard diagnostics;
- `44e2f610f53096451d4d47ab8d03a6c1821a6024`, which added
  `QueryGuard.isRunning` after serialized commands confused their own
  `dispatching` reservation with a running model turn;
- `112e09971475de7871610000c077a557bc374a83` and
  `ce722da65e354759c447163f942677c42e5b4d86`, which hardened immediate local-JSX
  ownership and dispatch races;
- `1caba1390828d7f283ac0543e9c4a2fe4ade575a`, which refined deferred-input
  settlement and origin preservation.

## 2. TUI evolution

### Reconstructed old pattern

The old TUI had two representations of one lifecycle:

1. React `isLoading`, whose updates could be batched and observed later;
2. synchronous ref `isQueryRunning`, used by immediate queue and submission
   paths.

`REPL.tsx:940-947` explicitly identifies their desynchronization as the reason
for replacement. The unsafe interval was not only the model request itself. A
queued item could be removed, then pass through asynchronous command or prompt
processing before `onQuery` began. During that interval, React could render or a
queue effect could rerun against stale state.

### Current `QueryGuard` pattern

`src/utils/QueryGuard.ts:1-18` defines:

```text
idle -> dispatching -> running -> idle
```

It also permits `idle -> running` for direct submissions.

- `reserve()` synchronously owns the pre-query dispatch gap
  (`QueryGuard.ts:35-52`).
- `tryStart()` atomically claims the actual turn and advances a generation
  (`QueryGuard.ts:67-87`).
- `end(generation)` refuses cleanup from an older turn
  (`QueryGuard.ts:89-113`).
- `forceEnd()` invalidates stale `finally` blocks by advancing the generation
  (`QueryGuard.ts:115-129`).
- `useSyncExternalStore` projects the synchronous guard into React
  (`REPL.tsx:940-959`).

This fixes four concrete classes of race:

1. React-batched state no longer competes with synchronous ref state.
2. `dispatching` prevents queue re-entry after dequeue but before `onQuery`.
3. `tryStart()` makes query admission one synchronous transition.
4. generation checks prevent an aborted turn's stale cleanup from clearing a
   replacement turn.

The first active render also resets elapsed-time refs before the spinner reads
them, closing the reservation-time `Date.now() - 0` display bug
(`REPL.tsx:1010-1022`).

### Current TUI status projection

The TUI intentionally distinguishes query exclusivity from visible activity:

- local activity is `QueryGuard.isActive`;
- remote/direct-connect/foreground-background activity uses
  `isExternalLoading`;
- display loading is their union (`REPL.tsx:949-959`).

`REPL.tsx:1242-1262` then derives:

```text
waiting = tool approval
       || prompt queue
       || outgoing worker request
       || outgoing sandbox request
       || visible local-JSX dialog
busy    = not waiting && isLoading
idle    = otherwise
```

That result drives:

- title animation and macOS sleep prevention (`REPL.tsx:1248-1260`);
- OSC 21337 tab status under `tengu_terminal_sidebar`
  (`REPL.tsx:1275-1281`, `src/ink/hooks/use-tab-status.ts`);
- best-effort PID activity writes for process listing
  (`REPL.tsx:1264-1273`, `src/utils/concurrentSessions.ts`).

Spinner visibility is broader. It includes input materialization, running
teammates, and queued task notifications, while hiding for selected blockers,
Sleep-only work, and visible streaming text (`REPL.tsx:1918-1931`).
`Spinner.tsx` can display leader `Idle` while teammates continue and can report
background task counts. These are useful presentation choices, but they prove
that spinner visibility is not the operational-state authority.

Current upstream 2.1.237 instead derives an object equivalent to:

```ts
const waitingFor = deriveWaitingReason(facts)
if (waitingFor !== undefined) {
  return { status: 'waiting', waitingFor, working: false }
}
return {
  status: facts.isLoading || facts.delegatedActive ? 'busy' : 'idle',
  waitingFor: undefined,
  working: facts.isQueryActive,
}
```

This separation is important: `working` identifies the main local turn, while
`busy` describes any session-owned activity. Cat Code should port that
distinction into the framework-independent domain rather than copying
upstream's minified controller shape verbatim.

### Remaining TUI gaps

1. **Waiting coverage is incomplete.** Local sandbox requests, worker sandbox
   requests awaiting the leader, and MCP elicitation can win dialog focus but
   are not all represented by `isWaitingForApproval`. A visible blocking dialog
   can therefore export `busy` or `idle`.
2. **Worker activity is omitted from exported state.** Running teammates and
   background tasks can keep the spinner or idle summary active while tab/PID
   status says `idle`.
3. **External activity is an unversioned shared boolean.** Multiple external
   producers can write `true` and `false` without an owner token or generation.
   A late `false` can clear another producer if those modes overlap. Current
   upstream's turn controller centralizes this boolean but does not make it
   owner-aware, so this remains a Cat Code hardening opportunity rather than an
   upstream fix to port.
4. **A dispatch reservation has no owner token.** `tryStart()` accepts any
   `dispatching` state. A cancelled asynchronous dispatch that resumes after a
   newer dispatch reserves the guard could claim the newer reservation. No
   focused reproducer currently proves this reachable, but the state machine
   does not make it impossible.
5. **Cat Code's transcript fallback is not inspectable here.**
   `concurrentSessions.ts` declares that process listing falls back to
   transcript-tail derivation when a live PID write is absent or stale, but
   `src/cli/bg.ts`, dynamically imported by `src/entrypoints/cli.tsx`, is absent.
   Current upstream confirms richer live PID semantics, but that does not reveal
   Cat Code's missing fallback consumer or justify guessing its tail rules.

## 3. Runtime and desktop state today

### Authoritative runtime facts

`AppSessionController` keeps separate in-memory facts for:

- `activeTurn`;
- pending engine-minted permission requests;
- abort state;
- goal snapshot.

See `src/app-runtime/AppSessionController.ts:56-88`.

A submit emits `turn.status(true)` before running the adapter and
`turn.status(false)` in `finally` (`AppSessionController.ts:135-193`). Permission
requests enter the map before `permission.requested` and leave before
`permission.resolved` (`AppSessionController.ts:95-107,224-240`). Abort emits
`requested`, denies pending permissions, signals cancellation, ends the turn,
and finally emits `aborted` (`AppSessionController.ts:110-133,178-192`).

The raw event union preserves these as separate event kinds
(`src/app-runtime/sessionEvents.ts:20-63`). That is the correct contract. A
unified operational enum must not replace or coalesce these events.

### Desktop projections

Desktop currently combines several independent stores:

- host `SessionDescriptor`: process/control-plane lifecycle;
- renderer `connectionState`: attachment and `turn.status` projection;
- `permissionState`: authoritative pending queue plus renderer submission state;
- `askQuestionState`: a view over the same permission queue;
- queued engine prompts and renderer-held cold-start submits;
- sidecar task, worker, OAuth, and durable-write facts used by the park gate.

The attach-time `app.ready` snapshot contains active-turn and pending-permission
facts; later `turn.status` events keep turn state live. `connectionState` maps
`activeTurn` to `inputEnabled = !activeTurn`. The composer intentionally remains
editable during an active turn so input can enter the bounded engine queue.
Consequently `inputEnabled` is a misleading field name if read as literal
editing capability: it means immediate idle-turn availability, not whether the
text box may accept input.

`app/renderer/src/tabStatus.ts:52-131` fuses descriptor lifecycle, connection
failure, and actionable permission count. `sessionStatusVisual.ts:37-89` owns
host-status chip vocabulary. Neither currently receives active-turn, abort,
queued-work, or worker/task facts.

### Current desktop contradictions

| Facts | Current readings |
|---|---|
| active turn, no blocker | descriptor `live`; pane `generating`; composer editable and submits to the turn queue; Stop visible |
| active turn, permission pending | descriptor `live`; pane `Waiting for approval`; underlying turn still `generating`; composer editable; Stop visible |
| abort requested | no dedicated renderer projection; UI remains generating/waiting until `turn.status(false)`, then Stop disappears before final abort classification |
| submitted permission awaiting authoritative resolution | pane remains paused; attention badge drops because submitted IDs are excluded |
| parked and restorable | connection has no engine; chip label `idle`; tone `busy`; composer restores on submit; Stop hidden |
| descriptor still ready after connection failure | tab escalates to disconnected/dead before host status catches up |

The first two are not inherently wrong. Waiting for a user and having an active
turn can both be true. The defect is treating each partial projection as if it
were the complete status.

### Idle parking already depends on richer truth

Main chooses nonvisible park candidates by TTL and least-recent use, but the
sidecar is authoritative at the park boundary. It refuses to park over:

- an active turn;
- queued prompts or task notifications;
- pending permissions;
- live tasks;
- durable writes;
- OAuth work.

This is stronger than any current tab status. A future memory reclaimer must
consume operational facts or the same authoritative gate; it must never infer
safety from a chip label or transcript heuristic.

## 4. Canonical domain model

### Design rule

Keep raw facts authoritative and derive operational state at read time.

Do not persist the derived enum as a second source of truth. PID files may cache
it for observability, but consumers must treat freshness and provenance
explicitly.

### Canonical module

Implement one dependency-free module at:

```text
src/sessionOperationalState.ts
```

Both TUI and desktop should import this exact source module. It must import no
React, Ink, Electron, Bun runtime, engine SDK, host API, or app protocol types.
Its public inputs are plain booleans and closed string unions. This is a narrow,
intentional exception to the desktop package's engine isolation: the renderer
imports one dependency-free semantic leaf, not the engine runtime graph.

`app/tsconfig.json` and the renderer build must include that exact source file.
A boundary test should reject imports inside the module and reject any other
renderer import from `src/`. This avoids a generated snapshot or duplicated
switch whose semantics can drift.

If direct cross-package source inclusion proves incompatible with the packaged
renderer build, stop rather than copy the function. The fallback is a tiny
internal package containing the same one module, not parallel implementations.

### Inputs

```ts
type SessionLifecycle =
  | 'starting'
  | 'connected'
  | 'parked'
  | 'disconnected'
  | 'dead'
  | 'closed'

type WaitingReason =
  | 'permission'
  | 'question'
  | 'elicitation'
  | 'worker-approval'
  | 'sandbox-approval'
  | 'dialog'

type WorkingReason =
  | 'dispatching'
  | 'turn'
  | 'stopping'
  | 'external-operation'
  | 'worker'
  | 'background-task'
  | 'queued-work'

type SessionOperationalFacts = {
  lifecycle: SessionLifecycle
  waiting: ReadonlySet<WaitingReason>
  working: ReadonlySet<WorkingReason>
}
```

The production API should use readonly arrays rather than `Set` if stable
serialization or straightforward fixture construction is preferred. The
semantic requirement is only that reasons are closed and deduplicated.

`queued-work` means accepted work that the session owns and is expected to
process. It does not mean a user-interaction prompt. The TUI's `promptQueue`
needs a clearer adapter name such as `interactivePromptPending`; desktop's
mid-turn queued prompts map to `queued-work`, not waiting.

### Output

```ts
type SessionOperationalState =
  | {
      kind: 'unavailable'
      reason: 'starting' | 'disconnected' | 'dead' | 'closed'
      lifecycle: SessionLifecycle
    }
  | {
      kind: 'waiting'
      reason: WaitingReason
      lifecycle: 'connected'
    }
  | {
      kind: 'working'
      reason: WorkingReason
      lifecycle: 'connected'
    }
  | {
      kind: 'idle'
      lifecycle: 'connected' | 'parked'
    }
```

Return all active reasons as secondary diagnostic fields if useful, but select
one primary reason by a closed, tested priority list. Presentation must not
reimplement primary-reason ordering.

Capabilities are derived separately from the same facts plus surface-specific
transport facts:

```ts
type SessionCapabilities = {
  composer: 'send-now' | 'queue-to-turn' | 'restore-then-send' | 'hold' | 'read-only'
  interrupt: 'hidden' | 'stop' | 'stopping'
  canAnswerBlocker: boolean
  canPark: boolean
}
```

These are not fields on the operational enum because the same `waiting` state
can allow text editing, permission response, and Stop simultaneously.

### Precedence algorithm

```ts
function deriveSessionOperationalState(
  facts: SessionOperationalFacts,
): SessionOperationalState {
  if (
    facts.lifecycle === 'starting' ||
    facts.lifecycle === 'disconnected' ||
    facts.lifecycle === 'dead' ||
    facts.lifecycle === 'closed'
  ) {
    return unavailableFor(facts.lifecycle)
  }

  if (facts.lifecycle === 'parked') {
    return { kind: 'idle', lifecycle: 'parked' }
  }

  const waiting = firstWaitingReason(facts.waiting)
  if (waiting) {
    return { kind: 'waiting', reason: waiting, lifecycle: 'connected' }
  }

  const working = firstWorkingReason(facts.working)
  if (working) {
    return { kind: 'working', reason: working, lifecycle: 'connected' }
  }

  return { kind: 'idle', lifecycle: 'connected' }
}
```

Required invariant tests:

1. unavailable beats every blocker and work reason;
2. waiting beats every work reason;
3. any work reason beats idle;
4. parked is idle but never `send-now`, interruptible, or parkable;
5. no unrecognized lifecycle or reason silently falls through;
6. reason ordering is exhaustive at compile time.

### Fact ownership

| Fact | Authoritative owner | Notes |
|---|---|---|
| query `dispatching`/`running` | TUI `QueryGuard` | Preserve admission and generation semantics; expose status, not only `isActive` |
| runtime active turn | `AppSessionController` `turn.status` | Attach snapshot plus live event |
| permission/question pending | engine pending request map | Renderer/TUI stores are projections; submitted does not mean resolved |
| abort requested/aborted | `AppSessionController` `abort.status` | Desktop must project it instead of discarding it |
| process lifecycle | desktop host descriptor plus connection escalation | Host and connection remain separate inputs; do not merge transport planes |
| worker/task activity | engine task/agent stores | Include foreground and background live work; use the same facts as park refusal |
| queued model work | engine command queue | Distinct from interactive prompts |
| visible local dialog | frontend adapter | UI-only blockers cannot be invented by the engine |
| parked | host/connection parked classification | Intentional restorable absence, not failure |

The engine does not need to emit a new operational event. It continues emitting
raw facts. Each observation boundary assembles facts and calls the same pure
deriver.

## 5. Surface adapters

### TUI adapter

Replace the inline `sessionStatus` expression in `REPL.tsx` with an adapter that
assembles:

- lifecycle `connected` while the REPL is alive;
- `dispatching` versus `turn` from the full QueryGuard status;
- external operations with owner-counted or tokenized activity, not one boolean;
- every focused input dialog category from the dialog-priority owner;
- active teammate, local-agent, and background-task work;
- queued work where the session still owns execution.

The upstream 2.1.237 turn controller is the reference for ownership boundaries,
not a wholesale source port. Cat Code should preserve its QueryGuard diagnostics
and explicit tool/prompt queue coverage while adopting upstream's dedicated
controller boundary, delegated-activity projection, broader blockers, and
process-registry semantics.

Map the result as follows:

| Consumer | Mapping |
|---|---|
| OSC 21337 | `working -> busy`, `waiting -> waiting`, `idle -> idle`; clear on unavailable/disabled |
| animated terminal title | animate only for `working`; waiting has a stable title indicator |
| `SpinnerWithVerb` | choose visibility and verb from operational state plus streaming presentation; never use spinner visibility as state truth |
| `BriefIdleStatus` | render idle summary only for `idle`; worker/task activity makes state `working` even if the leader is idle |
| macOS `caffeinate` | active for `working`, inactive for `waiting` and `idle` |
| PID activity JSON | write state, primary reason, timestamp, and source generation best-effort |

Tool approval, AskUserQuestion-style prompts, MCP elicitation, local and worker
sandbox approval, worker approval, and visible modal input must all map to
`waiting` through one adapter list. The dialog-priority function and operational
adapter should share the blocker predicate rather than maintain two lists.

QueryGuard should expose its closed status through `getStatusSnapshot()`. Keep
`isActive` and `isRunning` as convenience reads if callers need them. A future
hardening pass should give reservations owner tokens so an old asynchronous
dispatch cannot claim or cancel a newer reservation.

Replace `isExternalLoading` with an owner-aware activity set or generation-safe
counter keyed by operation owner. Starting and finishing one producer then
cannot clear another producer's activity.

### Process-list adapter and transcript fallback

This is a future architecture surface, not part of the current TUI port.
`BG_SESSIONS` is absent from both build feature sets, the activity writer is
compiled out, and this fork lacks the dynamically imported process-list reader.
Do not implement or verify this section until that feature is intentionally
restored with a real consumer.

A live PID-file publisher is the strongest TUI observation. Persist:

```text
status: busy | shell | waiting | idle
reason: closed vocabulary or absent
updatedAt: timestamp
statusUpdatedAt: timestamp changed only with status
publisherGeneration: monotonic process-local integer
processStartIdentity: platform process-start discriminator
source: live
```

For `cat-code ps` or equivalent tooling:

1. fresh live PID state wins;
2. stale or absent PID state may use transcript-tail inference for display only;
3. inferred state carries `source: transcript` and confidence;
4. an ambiguous tail yields `unknown`, never `idle`;
5. inferred state must never authorize cleanup, parking, abort, or ownership
   transfer;
6. subagent transcripts roll up to their registered leader only when an
   authoritative parent relationship exists;
7. a PID record is trusted or removed only after process-start identity proves
   the live process is the one that created it.

Because the current fallback consumer is absent from this repository, its
existing behavior must be recovered from an actual upstream artifact before an
implementation claims parity. Until then, treat this part as a contract for new
Cat Code behavior, not a description of upstream internals.

### Desktop adapter

Build one renderer selector that assembles operational facts from existing
stores. Do not add a new protocol frame or merge the host API with the raw event
plane.

| Consumer | Mapping |
|---|---|
| TabBar chip | unavailable uses lifecycle vocabulary; waiting uses attention tone; working uses busy tone; connected idle uses live/ready vocabulary; parked keeps quiet `idle` presentation |
| background attention | true only for actionable waiting in a background ready pane; submitted permission may use an in-progress marker but is no longer actionable |
| pane status | display primary operational state; optional secondary text may say a turn remains active while waiting |
| Stop button | `interrupt: stop` for active turn; `stopping` after abort requested; hidden otherwise |
| composer | idle connected `send-now`; working/waiting active turn `queue-to-turn`; parked `restore-then-send`; starting `hold`; terminal failure `read-only` |
| queued prompt row | driven by queue/pending-submit facts, not by `working` alone |
| idle parking | candidate only when authoritative `canPark`; never from visual idle alone |

Desktop must begin reducing `abort.status`. `requested` maps to working reason
`stopping` and interrupt capability `stopping`; final `aborted` is an outcome,
not durable work, and clears when the next turn begins as the controller already
does.

AskUserQuestion remains a view over the permission queue. It contributes waiting
reason `question`; it must not become a parallel pending store. A submitted
response remains waiting until authoritative `permission.resolved`, but
`canAnswerBlocker` becomes false while the response is in flight.

### Session chips versus operational state

`sessionStatusVisual()` currently answers host lifecycle presentation, not
operational state. Preserve that responsibility for history, preview, closed,
crashed, and parked descriptor-only rows. For a live pane/tab, layer the unified
operational result over its lifecycle base rather than adding more special cases
to `sessionStatusVisual()`.

This avoids forcing non-live catalog rows to pretend they have turn facts while
preventing live tabs from showing only descriptor `live` during a turn or wait.

## 6. Rollout plan

### Stage 1: Pure domain and fixtures

1. Add `src/sessionOperationalState.ts` with closed unions, pure derivation, and
   compile-time exhaustiveness.
2. Add a focused root test covering the complete precedence product.
3. Make the exact module available to app typecheck and renderer build without
   importing any other root module.
4. Add an app boundary test that proves this is the only renderer-to-`src/`
   production import and that the module itself has no imports.

### Stage 2: TUI adoption

1. Add a dedicated external-store turn controller around the existing
   QueryGuard, preserving Cat Code diagnostics.
2. Expose QueryGuard's full status snapshot through that controller.
3. Add a pure TUI facts adapter outside `REPL.tsx`.
4. Reuse the focused-dialog predicate so waiting coverage matches actual input
   focus.
5. Replace the shared external-loading boolean with owner-aware activity.
6. Include worker, teammate, local workflow, shell, and background-task
   activity, preserving upstream's terminal/idle/long-running exclusions.
7. Route OSC, title, spinner verb, caffeinate, and PID writes from the unified
   result.
8. Add upstream's `shell`, `statusUpdatedAt`, and process-start identity
   semantics to the PID registry.
9. Preserve specialized spinner suppression as presentation only.

### Stage 3: Desktop adoption

1. Reduce `abort.status` into per-session renderer state.
2. Add a pure desktop facts adapter joining descriptor, connection, permissions,
   asks, queue, tasks/workers, and pending submit.
3. Route tab, pane status, Stop, and composer capability through the unified
   result and capability selector.
4. Keep `sessionStatusVisual()` for descriptor-only lifecycle rows.
5. Feed idle-park candidate presentation from the same facts, while preserving
   the sidecar's authoritative final refusal gate.

### Stage 4: Observability fallback

Gate this entire stage on `BG_SESSIONS` entering an intentional build feature
set and a real process-list consumer landing. Then:

1. Recover the missing process-list/transcript-tail implementation from a
   verifiable upstream artifact or explicitly implement a Cat Code policy.
2. Add freshness and provenance to observations.
3. Ensure heuristics produce `unknown` on ambiguity and cannot drive destructive
   lifecycle actions.

## 7. Required test matrix

### Pure domain

Cover every lifecycle crossed with:

- no work/no blocker;
- each waiting reason;
- each working reason;
- multiple simultaneous reasons.

Mutation checks must prove that reversing any precedence comparison fails.

### TUI

Add focused tests for:

- queue reservation before `onQuery`;
- stale-generation cleanup;
- permission, prompt, elicitation, local sandbox, worker sandbox, worker
  approval, and local dialog waiting;
- leader idle plus active teammate;
- background task only;
- overlapping external activity owners;
- OSC clear when disabled;
- PID state and reason writes.

### Runtime and desktop

Add focused tests for event order and adapter output:

```text
turn true -> permission requested -> permission resolved -> turn false
abort requested -> permission resolved -> turn false -> abort aborted
```

Also cover:

- active turn with editable queueing composer;
- submitted-but-unresolved permission;
- AskUserQuestion and generic permission precedence;
- descriptor-ready plus connection-dead escalation;
- parked restore-on-submit;
- background task preventing idle classification and parking;
- abort `stopping` presentation;
- attach snapshots rebuilding state after missed events.

No test should hardcode presentation merely to make the enum pass. Tests must
assert the authoritative input facts and the resulting operational and
capability projections.

## 8. Invariants and non-goals

1. No new inbound frame, preload sender, or renderer-authored engine state.
2. No lossy replacement for raw `AppSessionEvent`.
3. No merging of host lifecycle/control-plane errors with engine event unions.
4. No use of transcript heuristics for idle parking or other lifecycle actions.
5. No assumption that `working` disables input.
6. No assumption that `waiting` ends the active turn.
7. No assumption that submitted permission means resolved permission.
8. No assumption that parked means crashed, connected, or interruptible.
9. No use of spinner visibility, chip tone, or button visibility as upstream
   state authority.
10. No claim of exact upstream history without an upstream ref or artifact that
    contains the old implementation. Current behavior may be established from a
    versioned official artifact without implying that the historical transition
    was recovered.

## 9. Decisions this design settles

- The canonical user-facing operational vocabulary is unavailable, waiting,
  working, and idle.
- Waiting takes precedence over working because it describes the next actor,
  not because the engine turn ended.
- Active workers and background tasks make the session working even when the
  leader can accept more input.
- Composer and Stop behavior come from capabilities, not direct enum checks.
- Parked is operationally idle with restore capability and no live engine.
- Raw runtime facts remain authoritative; the unified state is derived at read
  time.
- Both frontends execute the same pure precedence function.
- Process-list transcript fallback is explicitly heuristic and cannot establish
  safe idleness.
- Cat Code keeps its existing QueryGuard and ports upstream's superior
  controller boundary, delegated-activity status, blocker coverage, and PID
  identity semantics.

## 10. Unresolved evidence

1. The original pre-QueryGuard source and transition commit are absent from both
   the repository and the current published artifact.
2. The process-list transcript-tail consumer is absent, so Cat Code's current
   staleness and inference rules are unknown.
3. QueryGuard's reservation-owner race and overlapping external-loader race are
   structurally possible but do not yet have focused reproducers.
4. Some Cat Code focused-dialog categories have no exact upstream semantic
   match. Each must explicitly choose waiting or nonwaiting; voluntary
   navigation and informational surfaces must not inherit waiting merely from
   keyboard focus.
5. Direct inclusion of one dependency-free `src/` module in the isolated app
   renderer build must be proved before implementation; duplication is not an
   acceptable fallback.
