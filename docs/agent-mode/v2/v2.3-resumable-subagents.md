# Agent Mode v2.3 — Resumable Subagents

## Status
Draft design proposal.

## Problem

Agent Mode currently has a gap between how the orchestrator is supposed to behave and what the tool surface actually allows.

The orchestrator is expected to:
- keep worker continuity when a follow-up naturally belongs to an earlier worker
- avoid spawning redundant workers when an existing worker already has the right context
- preserve worker-local search trail and findings across turns

But the main tool surface only exposes fresh worker spawn semantics. In practice this means:
- the orchestrator can launch a worker
- the worker can complete and return findings
- later follow-up questions cannot be sent back to that same worker session
- the orchestrator must either redo the work in a fresh worker or absorb the follow-up itself

This creates unnecessary duplication, weakens context hygiene, and makes Agent Mode feel less like a true multi-turn coordinator.

## Example failure mode

Observed pattern:
1. User asks for investigation split across two workers.
2. Workers complete with useful findings.
3. User asks a narrow follow-up: "is this worth finishing?" or "go deeper on item 3".
4. The orchestrator should ideally resume the same worker(s).
5. Instead, it must either spawn fresh workers or do the synthesis itself.

This is especially awkward when the follow-up strongly overlaps the earlier worker scope. The right action is continuity, not re-dispatch.

## v2.3 goal

Add resumable subagent sessions so the orchestrator can continue prior workers across turns, independent of the worker's original agent type.

Short version:
- spawn once
- resume when overlap is high
- spawn fresh only when a clean-room context is actually better

## Non-goals

- No attempt to make every worker immortal or long-running forever
- No automatic worker resurrection after repo changes without validation
- No hidden background chatter between orchestrator and workers
- No requirement that every follow-up must reuse an existing worker
- No major redesign of the worker prompt system in v2.3

## Design principles

### 1. Continuity is a first-class capability
A worker session should be addressable after its initial response. "Completed" should mean "done with the current assignment," not "impossible to contact again."

### 2. Resume should be allowed across worker types
If a worker was originally launched as Explore, general-purpose, or another built-in type, the orchestrator should still be able to resume it. The worker keeps its original context, prompt, and role.

### 3. Resume is preferred when overlap is strong
If the user's follow-up is clearly a continuation of the same bounded investigation, the orchestrator should reuse the existing worker by default.

### 4. Fresh spawn remains available
Fresh workers are still the right choice when:
- the old worker context is polluted or too broad
- the task changed substantially
- an independent second opinion is wanted
- the earlier worker reached the wrong framing and should not anchor the follow-up

### 5. Session state must make workers discoverable
The orchestrator should not have to infer which worker exists from transcript archaeology alone. Worker identity and status should be tracked explicitly in session state.

## User-visible behavior

### Desired orchestrator behavior

When the user asks a follow-up like:
- "go deeper on item 3"
- "ask subagent 1 whether this is worth finishing"
- "continue the earlier worker"
- "have the same agent inspect the implementation risk"

The orchestrator should be able to:
1. identify the relevant prior worker
2. send a new message to that same worker session
3. receive a new result in the same worker thread
4. synthesize the result normally

### Desired mental model

From the user's perspective, workers become reusable collaborators within the session rather than single-shot disposable calls.

## Proposed API surface

Minimum viable shape:

### Spawn
```ts
Agent({
  description,
  prompt,
  subagent_type,
  ...
})
```

Returns a stable session-scoped worker handle.

### Resume
```ts
SendMessage({
  agent_id,
  prompt,
})
```

Semantics:
- targets an existing worker session
- appends a new user message into that worker conversation
- reuses the worker's existing context and role
- returns a normal completion/result payload

### Optional discovery helpers
```ts
ListAgents({ activeOnly?: boolean })
GetAgentStatus({ agent_id })
```

These are not strictly required if session state already exposes known workers cleanly, but they would reduce orchestration guesswork.

## Required runtime capabilities

### 1. Stable worker identity
Each spawned worker needs a stable ID that remains valid after completion.

Current state already appears close to this because subagent transcript sidecars and metadata files are persisted. v2.3 should promote that persisted identity into a reusable runtime handle.

### 2. Reopen completed worker sessions
A worker that completed successfully must be resumable.

"Completed" should mean:
- no active run in progress
- safe to append a new user message
- next resume creates a new run on top of prior context

### 3. Explicit status model
Worker status should distinguish:
- running
- completed
- failed
- killed
- resumable
- not resumable

A completed worker is usually resumable.
A killed or corrupted worker may not be.

### 4. Session-state registration
Session state should track, at minimum:
- worker id
- worker type
- description
- spawned-at time
- current status
- whether resumable
- parent objective or last assignment summary

This avoids forcing the orchestrator to search transcripts just to know whether a worker exists.

### 5. Transcript continuity
Resumed runs should append to the same worker transcript rather than creating unrelated follow-up transcripts.

That preserves:
- search history
- prior findings
- local reasoning trail
- any worker-specific assumptions already established

## Orchestrator decision rule

v2.3 should tighten orchestrator doctrine:

### Resume when
- the follow-up materially overlaps the previous worker's scope
- the earlier worker already gathered the key context
- continuity is more valuable than independence

### Spawn fresh when
- the user asks for a second opinion
- the task shape changed significantly
- the earlier worker seems anchored on a bad frame
- the worker's context is no longer trustworthy after major state changes

This should be expressed as a default, not just a suggestion.

## Interaction with compaction and recovery

Resumable workers only help if the system can still find them after compaction or interruption.

Therefore v2.3 should ensure:
- known workers are stored in durable session state
- resumability does not depend only on live in-memory references
- worker metadata can be reconstructed from sidecar metadata and transcript files if needed
- recovery logic treats resumable workers as first-class session assets

This is especially important for Agent Mode, where follow-up often happens several turns after the initial worker finished.

## Interaction with worker type

The user specifically called out a good requirement: the orchestrator should be able to resume **any** worker regardless of original type.

That is the right product rule.

Reason:
- "resume" is a session/continuity concept
- "agent type" is a role/prompt/tooling concept

Those should not be conflated.

A resumed Explore worker should still behave like Explore.
A resumed implementation worker should still behave like that worker.
But the orchestrator should not be blocked just because the earlier worker came from a different built-in category.

## Risks

### 1. Resuming stale workers after repo drift
A worker may hold assumptions from before significant file changes.

Mitigation:
- pass lightweight repo-change context on resume
- teach orchestrator to prefer fresh spawn when state drift is large
- optionally show "spawned before latest file changes" in worker status metadata

### 2. Over-reusing polluted context
Not every follow-up should continue old context.

Mitigation:
- make resume the default only for strong overlap
- preserve explicit fresh-spawn option
- allow orchestrator to request an independent clean-room worker when needed

### 3. Ambiguous worker selection
If multiple workers overlap, the orchestrator may pick the wrong one.

Mitigation:
- track descriptions and assignment summaries in session state
- surface recent completed workers clearly
- if ambiguity changes the result, ask the user which worker to continue

### 4. Runtime complexity
Resumability adds lifecycle complexity around completed, failed, and killed workers.

Mitigation:
- start with append-only transcript continuation
- avoid fancy live bidirectional worker channels in v2.3
- treat resume as "start a new run in an existing worker session"

## Recommended implementation shape

### Phase 1 — runtime support
- Persist stable worker handles in session state
- Mark completed workers as resumable
- Add a runtime entrypoint for sending a new prompt into an existing worker session
- Append resumed runs to the same worker transcript lineage

### Phase 2 — orchestrator enablement
- Update orchestrator prompt/doctrine to prefer resume for overlapping follow-ups
- Teach the orchestrator how to reference known workers without transcript archaeology
- Add user-facing language support for "resume the same worker"

### Phase 3 — recovery and UX
- Ensure compaction/recovery paths preserve resumable worker metadata
- Improve worker-status surfaces so users can see which workers are resumable
- Optionally expose recent worker handles in UI or session summary views

## Smallest sensible increment

If v2.3 is implemented narrowly, the smallest high-value increment is:

1. make completed workers resumable by stable id
2. add `SendMessage(agent_id, prompt)`
3. track known workers in session state
4. update orchestrator doctrine to resume when overlap is high

That alone would solve the main failure mode that motivated this doc.

## Why this is worth doing

This feature directly improves the core promise of Agent Mode:
- better context hygiene
- less duplicated exploration
- more natural follow-up handling
- more truthful multi-turn worker continuity

Without resumability, the orchestrator is still coordinating one-shot tool calls.
With resumability, it starts acting like a real manager of persistent collaborators.

## Success criteria

v2.3 should count as successful if all of the following are true:

- A worker spawned earlier in the session can be resumed by id after completion.
- Resuming works regardless of original worker type.
- The resumed worker continues in the same transcript/session lineage.
- The orchestrator can prefer resume over fresh spawn for overlapping follow-ups.
- Session recovery/compaction does not make prior workers undiscoverable.
- The user can naturally ask for "the same worker" and get the intended behavior.

## Open questions

1. Should `SendMessage` be exposed as a first-class tool, or should `Agent` gain an optional `agent_id` field for resume semantics?
2. Should killed workers ever be resumable, or should they require explicit restart semantics?
3. How much repo-drift metadata should be shown to the orchestrator on resume?
4. Does resumability require any tool-surface differences for worktree-isolated workers?
5. Should the UI expose resumable worker handles directly, or is internal session-state enough for v2.3?

## Recommendation

Build this.

Among the Agent Mode follow-up improvements, resumable subagents are high leverage because they fix a structural orchestration gap rather than adding another prompt patch.

This is a good v2.3 scope:
- bounded
- clearly motivated by observed behavior
- improves both user experience and runtime architecture
- reduces redundant worker churn without forcing a broad redesign
