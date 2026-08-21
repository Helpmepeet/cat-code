# Subagent account transcript stamp: adversarial design review

**Date:** 2026-08-21  
**Reviewed contract:** `docs/plans/2026-08-21-subagent-account-transcript-stamp-design.md` at `86853618`  
**Verdict:** RED. Rework the design before implementation.

The underlying timing defect is real, and stamping a historical fact into the transcript plane is directionally sound. The proposed design does not yet define a truthful fact across all of the execution paths it claims to cover. It also omits required schema and verification work.

## Findings

| ID | Severity | Finding | Disposition |
|---|---|---|---|
| F1 | High | A live lease does not prove that the worker is on the Codex path, so the proposed capture can falsely stamp an Anthropic worker with a Codex account. | Rework before implementation. Gate the stamp on the resolved request provider or move lease allocation/capture to the actual Codex request boundary. |
| F2 | High | Auto-backgrounded launch cards remain unstamped because the design writes only the later finalized task result, while the immutable card consumes the earlier `async_launched` acknowledgment. | Rework before implementation. Capture at the foreground-to-background transition and include the stamp in that acknowledgment if launch-account semantics are accepted. |
| F3 | High | Foreground aborts and failures before the first assistant message never call `finalizeAgentTool`, so they still lose all historical account identity. | Either narrow the contract explicitly to structured completions, or design a structured terminal result for these paths. |
| F4 | High | The claim that the auto-background finalization stamp keeps ResumeAgent cards and TaskOutput consistent is false: neither projection carries that field from the finalized task result. | Remove the claim or add explicit transcript-plane plumbing. Do not treat a task-state-only field as transcript evidence. |
| F5 | Medium | The background result schema is separate from `agentToolResultSchema`; the proposed schema edit is incomplete. | Add `account` to `asyncOutputSchema` as well as `agentToolResultSchema`, with focused parse tests. |
| F6 | Medium | The proposed ordering test cannot detect the production reorder it claims to guard against. | Exercise the real foreground cleanup/finalization path and assert that a registered lease becomes a stamped result despite cleanup. |
| F7 | Medium | A spawn-time stamp is not wrong only on failover. First-request repair and manual/follow-main reassignment can also move the lease, so `failoverCount` cannot justify the stated rarity. | Rename the fact to “dispatch account” and document all mutation cases, or capture the final account on a terminal row. |
| F8 | Medium | The verification battery omits required desktop gates and the renderer build gate. | Add `typecheck:sidecar`, `renderer:build`, the stale-reference sweep, and migration STATUS bookkeeping if implementation proceeds. |
| F9 | Medium | Persisting an account UUID and alias into session JSONL is an unresolved retention/privacy decision, not a non-blocking implementation detail. | Obtain and record the operator ruling before implementation. |

## Evidence and failure scenarios

### F1: provider-agnostic leases produce false attribution

`AgentTool` computes the actual resolved worker model at `src/tools/AgentTool/AgentTool.tsx:838`, but both background and foreground paths call `registerCodexLease` unconditionally at `src/tools/AgentTool/AgentTool.tsx:1257` and `src/tools/AgentTool/AgentTool.tsx:1387`. There is no provider check around either call. `registerCodexLease` selects and records a pool account whenever a selectable Codex account exists (`src/services/api/codexAccountLeaseManager.ts:152-191`).

That contradicts the design's load-bearing claim that “only a Codex-path worker ever has one.” A Claude/Anthropic worker spawned in a process with a healthy Codex pool can hold a preallocated Codex lease even though it never sends a Codex request. Snapshotting immediately after registration would permanently claim that it burned that account.

The actual request boundary already knows the provider and conditionally registers a missing subagent lease only for OpenAI requests at `src/services/api/claude.ts:1166-1178`. The design should either use that authoritative boundary or gate the AgentTool capture with the same resolved-provider rule. The stamp must represent an account actually eligible to serve this worker, not merely a speculative allocation.

### F2: the auto-background card still loses its account

When a foreground worker is auto-backgrounded, the Agent invocation returns a new `async_launched` acknowledgment at `src/tools/AgentTool/AgentTool.tsx:1735-1749`. That object is the immutable launch card's own structured result. The later worker completion calls `finalizeAgentTool` at `src/tools/AgentTool/AgentTool.tsx:1521-1525`, but the projector deliberately refuses to fold ordinary background completion facts into the launch card (`app/renderer/src/transcriptProjector.ts:637-643`, `:1660-1680`).

The design's capture point 3 adds the account only to the later finalized task result. That result cannot update the launch card, so the auto-background path continues to show the live account only while the lease exists and loses it at terminal. To implement option (a), capture the account at the transition and put it on the acknowledgment at `:1737`, not only on the detached completion result.

### F3: not every foreground terminal has a structured Agent result

Foreground cancellation rethrows `AbortError` after cleanup at `src/tools/AgentTool/AgentTool.tsx:1926-1956`. A foreground failure with no assistant message also rethrows at `src/tools/AgentTool/AgentTool.tsx:1959-1987`. Both paths run `unregisterAgentForeground` first at `src/tools/AgentTool/AgentTool.tsx:1868-1882`, which releases the lease through `src/tasks/LocalAgentTask/LocalAgentTask.tsx:797-824`. Neither path reaches `finalizeAgentTool` at `src/tools/AgentTool/AgentTool.tsx:2002`.

Those cards therefore receive a generic tool error rather than the proposed structured `account` field. If the contract remains “which account did this worker burn,” killed workers and early failed workers are part of it. The design must either preserve structured terminal metadata on these error paths or explicitly narrow its acceptance criteria.

### F4: finalized task results do not feed ResumeAgent or TaskOutput account display

The renderer's ResumeAgent identity merge copies only `agentName` and `agentUsage` from prior Agent results (`app/renderer/src/transcriptProjector.ts:621-662`). Completion notifications carry `AgentCompletionProjection`, not the finalized `AgentToolResult` (`app/renderer/src/transcriptProjector.ts:1660-1680`). Adding `account` to the detached result at `AgentTool.tsx:1521` therefore does not make it available to a ResumeAgent card.

TaskOutput also reduces a local agent result to clean text before returning it (`src/tools/TaskOutputTool/TaskOutputTool.tsx:76-85`); its public result shape has no account field (`src/tools/TaskOutputTool/TaskOutputTool.tsx:44-54`). The desktop projector extracts only that text envelope. A field retained solely in `LocalAgentTaskState.result` is not transcript-plane evidence and does not survive the routes claimed by the design.

Resumed runs add another gap: `resumeAgentBackground` registers a local task but does not eagerly register a lease (`src/tools/AgentTool/resumeAgent.ts:327-345`). A Codex lease can be registered later at the request boundary, but the ResumeAgent invocation's immediate result contains only success text (`src/tools/ResumeAgentTool/ResumeAgentTool.tsx:147-161`). A historical final account for a resumed run therefore requires completion-origin plumbing or another explicit transcript record.

### F5: async output schema is omitted

Synchronous Agent results derive from `agentToolResultSchema`, but background acknowledgments use the separate `asyncOutputSchema` at `src/tools/AgentTool/AgentTool.tsx:515-530`. The design changes only `agentToolResultSchema`. Adding `account` to the background acknowledgment object without extending `asyncOutputSchema` leaves the public tool contract incomplete and can fail type checking or strip the unknown field when restored TUI results are parsed through `tool.outputSchema` (`src/components/messages/UserToolResultMessage/UserToolSuccessMessage.tsx:56-65`).

### F6: the ordering tripwire is Potemkin coverage

The proposed test says that a lease released before capture should yield no account. That verifies `snapshotLeaseAccount` after deletion, not the production ordering between capture and `unregisterAgentForeground`. It would continue to pass if a future edit moved production capture below cleanup.

The regression test must drive the real foreground Agent path, arrange a registered lease, let the run complete, and assert that the returned structured result contains the account after the path has cleaned up its live lease. A narrower unit test is acceptable only if the ordering is moved into one exported/testable function whose call sequence cannot be bypassed by the production path.

### F7: the background semantic caveat is incomplete

The account may change through `failoverCodexLease`, but also through `repairCodexLeaseIfNonSelectable` (`src/services/api/codexAccountLeaseManager.ts:234-271`) and `reassignCodexLeaseToActiveAccount` (`:288-325`). The request client performs repair before selecting credentials (`src/services/api/client.ts:355-383`). A worker can therefore be stamped with account A at spawn and send its first billed request through account B without incrementing the failover counter cited by the design.

Option (a) is coherent only if the UI fact is explicitly “account assigned at dispatch,” not “account used” or “account burned.” If the UI continues to imply actual usage, final-account plumbing is required.

### F8: verification plan is incomplete

The design includes root build, focused engine tests, app tests, app typecheck, and hardening. The current project battery also requires `bun run --cwd app typecheck:sidecar` for every app change and `bun run --cwd app renderer:build` when renderer build inputs change. Completion also requires an exhaustive stale-reference search. Any migration implementation must update its own `docs/migration/STATUS.md` row as the final bookkeeping step.

### F9: transcript persistence needs an explicit ruling

The account ID and alias already cross the live outbound lease projection (`app/sidecar/leaseDomain.ts:229-255`), so this does not widen the inbound trust surface. Persisting the pair in every relevant session JSONL changes retention and discoverability, however. The repository's account diagnostic redactor treats both account IDs and aliases as identifying data (`src/services/api/accountDiagnostics.ts:65-70`, `:101-107`). The design correctly raises this question but cannot be accepted for implementation until the operator explicitly approves the new at-rest fact and its restore/export implications are recorded.

## Conformance summary

| Design item | Classification |
|---|---|
| Diagnose live-join lifetime defect | Implementable and source-confirmed |
| No new inbound protocol surface | Conforms |
| Foreground completed result stamp | Partial; ordering approach is sound but tests are insufficient |
| Background-from-start launch stamp | Partial; provider truth and schema are unresolved |
| Auto-background stamp | Missing from the immutable launch acknowledgment |
| ResumeAgent and TaskOutput consistency | Unsupported by current data flow |
| Anthropic omission | Contradicted by current provider-agnostic lease allocation |
| Restore persistence | Plausible for structured Agent results, unproven for all claimed terminal paths |
| Security/privacy acceptance | Open and blocking |
| Verification battery | Incomplete |

## Required design changes before implementation

1. Define the fact precisely: dispatch assignment or account actually used. Do not use “burned” for a spawn-time assignment.
2. Gate account stamping on the resolved Codex provider, not lease existence alone.
3. Add the account to both sync and async output schemas.
4. Cover the auto-background acknowledgment at `AgentTool.tsx:1737` if option (a) is chosen.
5. Decide whether aborted and early-failed foreground runs are in scope, then design their structured terminal metadata accordingly.
6. Remove the ResumeAgent/TaskOutput claim or add explicit completion-plane plumbing and tests.
7. Replace the helper-only ordering test with a production-path regression test.
8. Obtain the operator's explicit approval for persisting account ID and alias in session JSONL.
9. Expand the desktop verification battery and include stale-reference and STATUS bookkeeping.

No code or runtime behavior was changed by this review.