# Current Upstream Claude Code vs Cat Code Session Activity

**Date:** 2026-08-20

**Upstream artifact:** `@anthropic-ai/claude-code` 2.1.237

**Scope:** TUI query ownership and session `busy` / `waiting` / `idle` derivation

## Executive verdict

Current upstream Claude Code is better at deciding whether a whole session is
busy or waiting. It does **not** have a materially better QueryGuard state
machine.

Cat Code should:

1. keep its existing QueryGuard and transition diagnostics;
2. port upstream's aggregate delegated-work derivation into live TUI status;
3. broaden waiting classification to cover actual session-blocking dialogs;
4. preserve Cat Code's explicit tool and prompt queue checks so their richer
   request details survive upstream's generic permission fallback.

The first implementation slice should be the pure activity deriver and its
characterization tests plus live REPL adoption. Turn-controller extraction is
an optional separate follow-up, justified only by concrete lifecycle defects or
maintenance pressure. PID hardening is deferred until Cat Code actually ships
`BG_SESSIONS` and has a process-list reader.

## 1. Evidence and limitations

### Official current artifact

The comparison uses the official npm packages published for Claude Code
2.1.237 on 2026-08-19, not Cat Code's historical git snapshots.

| Artifact | SHA-256 |
|---|---|
| `claude-code-2.1.237.tgz` wrapper | `94253aceefc12d015b7889932d1707c8af74ca839b876bda8cadfc3e4f3a7333` |
| `claude-code-darwin-arm64-2.1.237.tgz` | `c5978b8e6549bdf39130e53404a88dc259724bed8ac49c82ee87f8cd231ed5a8` |
| unpacked Darwin arm64 executable | `338901351d4ff17495738c67fc3e12a32c1b506738ac5e012eb782d3d8b5be43` |

The executable reports `2.1.237 (Claude Code)`.

### Packaging limitation

The npm wrapper no longer contains readable application JavaScript. It selects
an architecture-specific package whose native executable is a minified Bun
bundle. There is no source map, and symbol names are obfuscated.

The following are still directly verifiable:

- string-valued states and status vocabulary;
- state transitions;
- object shapes;
- conditions used by status derivation;
- relationships among the guard, controller, task classification, OSC output,
  and PID registry.

Artifact-local minified names such as `MPc`, `BPc`, `iEg`, and `nkE` are useful
for reproducing this investigation against exactly 2.1.237. They are not stable
upstream APIs and should not appear in production code.

### Historical limitation

Cat Code's two disconnected root snapshots already contain QueryGuard. Neither
the old dual-state implementation nor the transition commit is available. This
report compares current bundled behavior; it does not claim to reconstruct the
exact historical upstream patch.

## 2. QueryGuard comparison

### Current Cat Code

`src/utils/QueryGuard.ts:30-151` owns:

```text
idle -> dispatching -> running -> idle
```

It also permits direct `idle -> running` admission.

- `reserve()` synchronously owns the asynchronous pre-query gap.
- `cancelReservation()` releases work that never reached a query.
- `tryStart()` admits one running turn and advances the generation.
- `end(generation)` rejects stale cleanup.
- `forceEnd()` invalidates a cancelled turn's eventual cleanup.
- `isActive` includes dispatching and running.
- `isRunning` includes only the actual model turn.

Cat Code logs blocked and successful transitions at
`src/utils/QueryGuard.ts:39-50,73-85,94-110,121-128`.

### Current upstream 2.1.237

The identifiable minified guard is materially equivalent:

```js
class MPc {
  _status = "idle"
  _generation = 0

  reserve() {
    if (this._status !== "idle") return false
    this._status = "dispatching"
    this._notify()
    return true
  }

  cancelReservation() {
    if (this._status !== "dispatching") return
    this._status = "idle"
    this._notify()
  }

  tryStart() {
    if (this._status === "running") return null
    this._status = "running"
    ++this._generation
    this._notify()
    return this._generation
  }

  end(generation) {
    if (this._generation !== generation) return false
    if (this._status !== "running") return false
    this._status = "idle"
    this._notify()
    return true
  }

  forceEnd() {
    if (this._status === "idle") return
    this._status = "idle"
    ++this._generation
    this._notify()
  }

  get isActive() {
    return this._status !== "idle"
  }

  get isRunning() {
    return this._status === "running"
  }
}
```

### Verdict on QueryGuard

| Question | Verdict |
|---|---|
| Does upstream have a richer guard state machine? | No |
| Does upstream prevent stale turn cleanup differently? | No material difference |
| Does upstream solve dispatch reservation ownership? | No evidence that it does |
| Which guard is easier to diagnose? | Cat Code, because it logs transitions |
| Should Cat Code replace QueryGuard wholesale? | No |

The useful upstream changes are around the guard, not inside it.

## 3. Turn-state ownership

### Cat Code today

The REPL owns related state in several inline pieces:

- QueryGuard subscription and derived loading:
  `src/screens/REPL.tsx:940-959`;
- first-active-render timing correction:
  `src/screens/REPL.tsx:1010-1022`;
- external loading wrapper:
  `src/screens/REPL.tsx:1024-1032`;
- abort and cancellation behavior in the REPL query lifecycle;
- query execution and cleanup in the REPL query callback.

This is correct enough to run, but ownership remains spread across a large React
component. A state transition can require coordinated changes to guard state,
React state, timing refs, abort state, and query cleanup.

### Upstream 2.1.237

Upstream wraps the equivalent QueryGuard in a dedicated external-store turn
controller. The controller owns:

- QueryGuard;
- query-active and external-loading projection;
- aggregate loading;
- stream state;
- abort controller;
- turn start and paused duration;
- submit count and last completion time;
- query execution;
- cancellation and cleanup.

Its snapshot begins with an object equivalent to:

```ts
{
  isQueryActive: false,
  isExternalLoading: initialExternalLoading,
  isLoading: initialExternalLoading,
  submitCount: 0,
  lastQueryCompletionTime: 0,
  abortController: null,
}
```

The controller publishes `isLoading` synchronously from query and external
activity and resets timing on the inactive-to-active transition. The REPL
subscribes to that one snapshot instead of assembling those ownership concerns
itself.

### Why upstream is better here

- Turn transitions have one non-React owner.
- Timing resets happen in the same publication boundary as loading changes.
- Query execution and cancellation share the same guard and abort owner.
- React consumes a snapshot rather than coordinating several mutable sources.
- The state-owner boundary is independently testable outside the full REPL.

This is a structural improvement, not a different definition of QueryGuard.

### What not to copy blindly

Upstream still represents external activity as one boolean inside the
controller. It centralizes that boolean but does not visibly give overlapping
producers owner tokens. Cat Code should use an owner-aware activity set or
counter when extracting its controller rather than preserving that weakness.

## 4. Busy and working derivation

### Cat Code today

Cat Code derives approximately:

```ts
const waiting =
  toolUseConfirmQueue.length > 0 ||
  promptQueue.length > 0 ||
  pendingWorkerRequest ||
  pendingSandboxRequest ||
  isShowingLocalJSXCommand

const status = waiting ? 'waiting' : isLoading ? 'busy' : 'idle'
```

See `src/screens/REPL.tsx:1242-1262`.

`isLoading` is:

```ts
isQueryActive || isExternalLoading
```

See `src/screens/REPL.tsx:949-959`.

Running teammates and queued task notifications affect spinner visibility at
`src/screens/REPL.tsx:1918-1928`, but they do not contribute to the exported
session status at `src/screens/REPL.tsx:1261-1281`.

This can produce:

```text
leader query idle + delegated worker active -> exported idle
```

### Upstream 2.1.237

Upstream derives an object equivalent to:

```ts
function deriveActivity(facts) {
  const waitingFor = deriveWaitingReason(facts)

  if (waitingFor !== undefined) {
    return {
      status: 'waiting',
      waitingFor,
      working: false,
    }
  }

  return {
    status:
      facts.isLoading || facts.delegatedActive
        ? 'busy'
        : 'idle',
    waitingFor: undefined,
    working: facts.isQueryActive,
  }
}
```

The distinction is deliberate:

| Situation | Upstream `status` | Upstream `working` |
|---|---|---|
| main local query running | `busy` | `true` |
| external operation active | `busy` | `false` |
| delegated worker active after leader turn | `busy` | `false` |
| blocked on user | `waiting` | `false` |
| no owned work | `idle` | `false` |

`working` means the main local query is active. `busy` means the session owns
some active work. Waiting describes who must act next and therefore overrides
both.

### Delegated work counted by upstream

The task classifier includes active:

- local agents;
- remote agents;
- in-process teammates;
- local workflows.

It excludes:

- terminal task states;
- idle in-process teammates;
- deliberately long-running remote agents.

The exclusions matter. Counting every retained task row as active would leave
sessions permanently busy. Cat Code should port the lifecycle-aware predicate,
not merely check whether a task exists.

### Verdict on busy detection

Upstream is better because it asks:

```text
Does this session own active work?
```

Cat Code currently asks approximately:

```text
Is the leader query or one external-loading path active?
```

That is the main logic improvement worth porting first.

## 5. Waiting derivation

### Cat Code strengths

Cat Code explicitly marks these as waiting:

- ordinary tool approval queue;
- prompt queue;
- outgoing worker request;
- outgoing sandbox request;
- visible local-JSX dialog.

Those checks are directly readable at `src/screens/REPL.tsx:1242-1262`.

### Cat Code gaps

The actual focused-dialog owner handles a broader set around
`src/screens/REPL.tsx:2249-2288`, including:

- local sandbox requests;
- worker sandbox requests;
- MCP elicitation;
- other input-owning dialogs.

Because status and dialog focus maintain separate lists, a dialog can own user
input while status says `busy` or `idle`.

### Upstream 2.1.237

Verified upstream waiting reasons include:

- AskUserQuestion -> `input needed`;
- ordinary permission dialogs -> `permission prompt`;
- worker sandbox prompt -> `sandbox request`;
- MCP elicitation -> `input needed`;
- mapped top-dialog blocker -> its mapped reason;
- outgoing worker request -> `worker request`;
- outgoing sandbox request -> `sandbox request`;
- local interactive dialog -> `dialog open`.

Waiting takes precedence over aggregate busy.

Upstream's top-dialog converter uses a mapped reason when one exists and falls
back to `permission prompt` for every other registered permission-dialog kind.
This covers identifiable Bash, file, WebFetch, Skill, PowerShell, browser,
monitor, plan-mode, peer-approval, and auto-mode permission dialogs.

The port should still take the union of Cat Code's proven tool/prompt queues and
upstream's broader sandbox, elicitation, worker, and top-dialog coverage. Cat
Code's queue-specific detail such as `approve Bash` is more informative than
upstream's generic fallback.

The focused-dialog predicate and activity adapter should share one blocker
classification so their lists cannot drift again.

Not every focused UI surface is operationally waiting. Message selection,
recommendations, informational callouts, and upsells are voluntary navigation
or nonblocking UI. The Cat Code adapter must make an explicit waiting/nonwaiting
choice for every focused-dialog member rather than defaulting every modal to
waiting.

## 6. Shell activity

Upstream's process registry supports:

```text
busy | shell | waiting | idle
```

An active local shell task can export `shell` instead of appearing idle or being
flattened into generic busy.

This is useful for process-list observability. It does not require a fourth
user-facing OSC state. The TUI can continue mapping shell activity to the busy
terminal-tab presentation while retaining `shell` in PID records and process
listing.

Cat Code currently defines only:

```ts
'busy' | 'idle' | 'waiting'
```

at `src/utils/concurrentSessions.ts:18-19`.

This is not a live port target in the current fork. `BG_SESSIONS` appears in
neither build feature set, `updateSessionActivity()` returns immediately without
it, and the dynamically imported process-list implementation is absent.
Consequently no current Cat Code consumer can observe a new `shell` value.

## 7. PID activity safety

### Cat Code today

Cat Code's activity writer records status, optional waiting reason, and
`updatedAt` at `src/utils/concurrentSessions.ts:150-160`.

A general record update can therefore obscure how long the status itself has
been unchanged.

### Upstream 2.1.237

Upstream additionally records:

- `statusUpdatedAt`, changed only when status changes;
- process-start identity alongside the PID;
- liveness classification that distinguishes the same process from a reused PID.

Before trusting or removing a record, upstream checks both PID liveness and the
process-start discriminator. This closes the class of error where the operating
system reuses a PID for an unrelated process.

### Recommended port

Do not port this yet. If `BG_SESSIONS` later ships with a real process-list
reader, use a separate persistence-focused change shaped like:

```ts
type SessionStatus = 'busy' | 'shell' | 'idle' | 'waiting'

type ActivityRecord = {
  status: SessionStatus
  waitingFor?: string
  updatedAt: number
  statusUpdatedAt: number
  processStartIdentity: string
}
```

The exact platform representation should then follow the upstream-observed
behavior and Cat Code's process utilities. Do not invent a cross-platform PID
identity scheme inside the live TUI activity change.

## 8. OSC 21337 comparison

Both implementations use the same OSC 21337 status vocabulary and palette:

| State | Indicator |
|---|---|
| idle | green `Idle` |
| busy | orange `Working…` |
| waiting | blue `Waiting` |

Cat Code owns this at:

- `src/ink/termio/osc.ts`;
- `src/ink/hooks/use-tab-status.ts:11-71`;
- `src/screens/REPL.tsx:1275-1281`.

Upstream can substitute a post-turn summary detail for the idle text. That is a
presentation enhancement, not part of the operational-state correctness work.
It should not be coupled to the busy-derivation port.

## 9. Current-versus-upstream summary

| Concern | Cat Code | Upstream 2.1.237 | Better |
|---|---|---|---|
| QueryGuard states and generations | full implementation with diagnostics | materially equivalent | Cat Code diagnostics |
| Turn-state ownership | distributed through `REPL.tsx` | dedicated external-store controller | Upstream |
| Main query versus aggregate activity | mostly one `isLoading` projection | separate `working` and aggregate `busy` | Upstream |
| Delegated agents and workflows | spinner-oriented, not exported status | lifecycle-aware `delegatedActive` | Upstream |
| Generic tool/prompt queues | explicit waiting checks with tool detail | mapped reason or `permission prompt` fallback | Same state; Cat Code detail |
| Sandbox and elicitation waiting | incomplete status list | broader mapped blockers | Upstream |
| Shell process status | compiled-out writer, no reader | `shell` | Upstream, but not currently portable |
| Status-change timestamp | compiled-out activity writer | separate `statusUpdatedAt` | Upstream, deferred |
| PID reuse protection | liveness-only registry | PID plus process-start identity | Upstream, deferred until a reader ships |
| External-loading ownership | shared boolean | centralized shared boolean | Neither solves overlap |
| OSC 21337 core protocol | implemented | materially equivalent | Same |

## 10. Implementation sequence

### Change 1: Pure session activity derivation

Add a framework-independent deriver with inputs for:

- aggregate loading;
- delegated activity;
- closed waiting reasons.

Return:

```ts
type TuiSessionStatus = 'busy' | 'waiting' | 'idle'
```

Required characterization cases:

```text
leader query active                  -> busy
leader idle, delegated agent active  -> busy
query active, permission pending     -> waiting
worker active, elicitation pending   -> waiting
idle teammate only                   -> idle
completed task only                  -> idle
nothing active                       -> idle
```

### Change 2: TUI facts adapter

Build one adapter outside `REPL.tsx` that:

- preserves existing tool and prompt queue checks;
- shares blocker classification with focused-dialog ownership;
- derives delegated activity from engine task lifecycle;
- supplies the pure deriver.

Route the primitive status through live title, sleep-prevention,
goal-continuation, and already-gated OSC consumers. Keep specialized spinner
suppression as presentation logic. Do not add `working` or `shell` fields with
no live consumer.

### Deferred: PID persistence hardening

Do not implement while `BG_SESSIONS` is absent from both build feature sets and
the process-list reader is missing. If that feature is intentionally restored,
write a new plan covering `shell`, `statusUpdatedAt`, process identity, atomic
registry writes, and reader compatibility.

### Optional Change 3: Turn-controller extraction

Move QueryGuard, external activity, abort ownership, timing, execution, and
cleanup behind one external store. Preserve Cat Code's diagnostics and improve
external activity to be owner-aware instead of copying upstream's single
boolean.

Do this only if concrete lifecycle bugs or repeated REPL maintenance problems
justify its risk. It must come after status behavior is characterized so a
structural refactor cannot silently redefine busy or waiting.

## 11. Non-goals

- Do not replace QueryGuard wholesale.
- Do not copy artifact-local minified symbol names or structures.
- Do not make spinner visibility the activity authority.
- Do not count every retained task row as active.
- Do not remove Cat Code's explicit tool and prompt queue checks.
- Do not classify voluntary navigation, recommendations, callouts, or upsells
  as operational waiting merely because they own keyboard focus.
- Do not couple post-turn OSC summaries to activity correctness.
- Do not use PID or transcript heuristics for desktop idle parking.
- Do not combine the TUI activity port with desktop protocol changes.

## 12. Final recommendation

Port upstream's **live aggregate activity semantics**, not its QueryGuard or
currently unreachable PID machinery.

The smallest correct first change is:

```text
pure status deriver
+ lifecycle-aware delegated activity
+ complete waiting classification
+ live REPL consumers switched to the derived status
```

The turn controller remains a separate change. PID hardening remains gated on
the feature and reader becoming real. This order captures the upstream
correctness improvement without spending most of the work on dead code.
