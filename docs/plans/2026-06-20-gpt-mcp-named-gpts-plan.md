# GPT MCP Named GPTs Plan

## Product target

The GPT MCP should present Codex-backed workers to Claude as named GPTs.

Claude should not need to think in job IDs or Cat Code session IDs for normal continuation. It should create a named GPT, read the result, and later send another message to that same named GPT.

The desired product model is “current Claude Code harness session.” The MCP consumer is upstream Claude Code, not this Cat Code fork session. Cat Code source can suggest likely MCP behavior, but it is not authoritative for the target harness. Before shipping, verify upstream Claude Code stdio MCP lifecycle directly or empirically. If upstream provides no stable chat/session identifier, use MCP process lifetime as the explicit fallback and describe it honestly.

## Decisions from user interview

- Call them “GPTs” or “named GPTs,” not helpers.
- The user of the MCP is Claude running in the Claude harness, not Cat Code’s own UI.
- A named GPT should have a unique visible name in the current MCP process.
- Continuing a GPT should be phrased as sending a message to that GPT, not spawning or resuming a job.
- No live mid-run messaging is needed for now. If a GPT is still running, follow-up can wait until it finishes.
- Job IDs and Cat Code session IDs may remain available for status/debug/logs, but they should not be the primary UX.
- If a new GPT name conflicts with an existing GPT in the current process, return a hard error instead of silently reusing or creating a duplicate.
- `list_gpt_agents` is the normal “is it done yet?” surface. A busy GPT should tell Claude to check `list_gpt_agents`, not force Claude into job IDs.
- Named GPTs must have one source of truth. The in-memory GPT registry owns visible names, status, and the session ID to resume.

## Current implementation shape

The live Claude MCP config points to:

```text
~/.cat-code/mcp/gpt-agent.ts
```

That file imports:

```text
/Users/pt/cat-code/scripts/mcp/gpt-agent.ts
```

The working tree is already partially named-GPT-shaped. It currently exposes:

```text
spawn_gpt_agent
send_gpt_agent_message
list_gpt_agents
get_gpt_agent_job_status
get_gpt_agent_job_result
wait_for_gpt_agent_job
tail_gpt_agent_job_log
cancel_gpt_agent_job
list_gpt_agent_jobs
cleanup_gpt_agent_job
```

It already has an in-memory `gptRegistry`, named create/send/list code paths, and tests for some named-GPT behavior. The remaining work is not greenfield; it is closing the drift between the current implementation and the named-GPT contract.

Known current drift to fix:

- Normal `tools/list` should expose read-only result retrieval but hide mutating/log job debug tools by default.
- Named GPT runs still write `name -> sessionId` into the global conversation store.
- `send_gpt_agent_message` still resumes through the global conversation store instead of the `GptRecord.sessionId`.
- Prompt-cache freshness gating is not implemented.
- `replace_existing` is not implemented.
- Foreground names are not reserved before execution, so concurrent same-name spawns can slip through.
- Foreground sends are not marked running before execution, so concurrent sends can queue on the internal lock instead of returning busy.
- Debug job cleanup can strand a named GPT in a stale busy state.
- Existing tests that assert global conversation-store writes for named GPTs must be changed, not preserved.

The script currently stores conversation mappings and background jobs globally by default:

```text
~/.cat-code/mcp/conversations.json
~/.cat-code/mcp/jobs/
```

`/Users/pt/cat-code/scripts/mcp/` is currently untracked, so any implementation here must intentionally include those files if this MCP belongs in the repo.

## Proposed tool surface

Expose the named-GPT tools and read-only background result retrieval needed for the normal flow:

```text
spawn_gpt_agent
send_gpt_agent_message
list_gpt_agents
get_gpt_agent_job_status
get_gpt_agent_job_result
wait_for_gpt_agent_job
```

Minimum viable change:

- Add `send_gpt_agent_message`.
- Add `list_gpt_agents`.
- Update `spawn_gpt_agent` wording and behavior so it creates named GPTs, not just jobs.
- Make `spawn_gpt_agent` create-only for visible names. Continuing a named GPT belongs only in `send_gpt_agent_message`.
- Keep mutating/log job tools as lower-level debug tools, but expose read-only result retrieval in the default normal-flow `tools/list`.

Mutating/log debug tools may remain available behind an explicit debug flag such as `GPT_AGENT_DEBUG_TOOLS=1`:

```text
tail_gpt_agent_job_log
cancel_gpt_agent_job
list_gpt_agent_jobs
cleanup_gpt_agent_job
```

Do not add named mirrors for every job tool yet. Use `list_gpt_agents` for normal status polling and the result retrieval tools when Claude needs the saved background output by `job_id`. Add named wait/tail/cancel tools only if Claude repeatedly needs them in normal flow after mutating/log job tools are hidden by default.

## State model

Add a GPT registry separate from raw job records:

```ts
type GptRecord = {
  name: string
  status: 'running' | 'completed' | 'failed' | 'cancelled'
  sessionId?: string
  activeJobId?: string
  lastJobId?: string
  model: Model
  description?: string
  createdAt: string
  updatedAt: string
}
```

Normal lookup key is `name`.

The first implementation should keep this registry in memory in the MCP server process. This registry is the source of truth for named GPTs. It should not load global `~/.cat-code/mcp/conversations.json` entries as visible named GPTs.

Internals can still use:

- `job_id` for detached process artifacts.
- `sessionId` from the `GptRecord` for `cat-code --resume`.
- existing job result/status files for logs and lifecycle.

Named GPTs must not use the global conversation store as their session source of truth:

- Do not persist visible named-GPT mappings to `~/.cat-code/mcp/conversations.json`.
- Do not resume a named GPT by looking up `store[name]`.
- `send_gpt_agent_message` must resume exactly the `sessionId` stored in the reconciled `GptRecord`.
- Existing global conversation storage may remain only for legacy/debug flows that are not the named-GPT product surface.
- Named-GPT tests must stop asserting writes to `conversations.json`; those assertions currently pin the old behavior.
- Locking and pending-commit code for the global store should be removed from the named-GPT path or fenced behind legacy/debug-only code. Do not keep it in the product path “just in case.”

Detached workers cannot directly mutate the parent MCP server’s in-memory registry. The implementable shape is:

- Parent MCP registry stores `name -> activeJobId` when starting a background GPT.
- Worker keeps writing existing job status/result files.
- `list_gpt_agents`, `send_gpt_agent_message`, and any future named status call reconcile from job files before responding.
- Reconciliation updates `status`, `sessionId`, `updatedAt`, and last debug job ID in the in-memory registry.
- Debug job cleanup must not strand a named GPT in a stale busy state. If job artifacts are removed before reconciliation, the named record should either keep the last known terminal state or become a clear non-continuable error, not remain `running` forever.
- Reconciliation must distinguish missing job artifacts from transient read/parse failures. A missing job for a non-terminal named GPT may become a clear terminal/non-continuable state; a partial write or parse failure should not prematurely mark a healthy job failed.

## Session scoping

Desired behavior is Claude-harness-session scoped.

Current Cat Code fork evidence, useful only as a clue:

- Stdio MCP servers are spawned as subprocesses by the Claude Code harness.
- The MCP client sends static `clientInfo`, roots/cwd, configured env, and `claudecode/toolUseId` per tool invocation.
- No stable Claude session ID, transcript path, or conversation ID is passed through env, initialize params, or tool-call `_meta`.
- `claudecode/toolUseId` is per-call, not per-session.
- In this fork, `connectToServer` is memoized by server name and config, not by session ID.
- `useManageMCPConnections` re-runs on `getSessionId()` changes, but unchanged stdio server configs reuse the memoized connection instead of clearing the subprocess.
- This means in-memory MCP state is process-scoped and may survive `/clear` or other in-process session switches.

Target-harness requirement before shipping:

- Verify upstream Claude Code stdio MCP lifecycle and metadata, not just this fork.
- If upstream Claude Code passes no stable session ID to stdio MCP, use MCP server process lifetime as the closest available boundary.
- If upstream Claude Code does pass a stable session ID or per-session env, key named GPTs by that instead.

The fallback implementation is:

```text
in-memory name -> GptRecord registry
```

If the MCP process restarts, named GPTs from the prior process are not guaranteed to appear in `list_gpt_agents`. If upstream Claude Code keeps the MCP process alive across `/clear`, named GPTs may also survive `/clear`. That is an accepted MVP limitation only after upstream behavior is verified and tool wording says process-scoped, not chat-scoped.

If upstream Claude Code exposes a stable session ID to stdio MCP servers, use a real session-scoped registry keyed by that ID. Do not default to global cross-day named GPTs.

## Behavior details

### Creating a GPT

`spawn_gpt_agent` should create a named GPT.

Rules:

- If `name` is provided and unused in the current process, use it.
- If `name` is missing, generate a short unique fallback such as `GPT 1`.
- Keep `description` as description only. Do not use it as the generated name.
- Do not derive names from the prompt.
- If `name` already exists, return `isError: true` telling Claude to use `send_gpt_agent_message` to continue it, or choose a different name for a separate GPT.
- Do not silently resume an existing name from `spawn_gpt_agent`.
- Reserve the name in the registry before starting foreground or background work, so concurrent spawns with the same name hard-error immediately.
- If reservation succeeds but foreground startup/execution fails before producing a useful record, roll back the reservation unless the failure itself should remain visible as a named failed GPT.
- Allow an explicit replacement path for bricked names: `replace_existing: true`.
- `replace_existing: true` may replace only terminal/non-running GPTs. If the existing GPT is `queued`, `running`, or `cancelling`, return busy and tell Claude to check `list_gpt_agents`.
- Replacing a terminal GPT rebinds the visible name to a fresh record and does not imply resume.
- Do not cancel or orphan a running job from `replace_existing`; named cancellation is out of scope for the MVP.

The result should lead with the named GPT abstraction:

```text
Started GPT "Hooks Recon" in the background.
To continue after it finishes, use send_gpt_agent_message with to: "Hooks Recon".
Debug job_id: job_...
```

### Sending a message to a GPT

`send_gpt_agent_message` should accept:

```ts
{
  to: string
  message: string
  run_in_background?: boolean
}
```

Behavior:

- If `to` is unknown, return a clear error and include known names.
- Reconcile the named GPT from its job files before deciding whether it can be messaged.
- If the GPT is running, return a clear “busy” result for now. Tell Claude to call `list_gpt_agents` and retry when the GPT is `completed`. Do not queue mid-run messages yet.
- If the GPT has a completed `sessionId`, run Cat Code with `--resume <sessionId>` and the new message.
- Before resuming, apply a prompt-cache freshness gate. Resume is still possible after cache expiry, but it may stop being cheaper than starting a fresh GPT.
- If the GPT failed before producing a session, say it cannot be continued and point to logs/status.
- If the GPT failed after producing a session, keep it continuable. A failed status without a session is bricked; a failed status with a session can still be resumed unless the prompt-cache gate declines.
- Update the GPT record with the new session ID after a successful follow-up.
- Default to foreground execution. Use `run_in_background: true` only when Claude explicitly wants the follow-up to run detached.
- Mark the GPT as running before starting a foreground follow-up, so concurrent sends return busy instead of waiting on an internal lock.

Prompt-cache policy:

- The prompt-cache gate is in scope for this change.
- Use `GptRecord.updatedAt` after reconciliation as the age source.
- For `gpt-5.5`, allow normal resume for 0–2 hours after the GPT was last updated.
- For `gpt-5.5`, allow resume with a warning from 2–24 hours: the prompt cache may be colder and usage may be higher.
- For `gpt-5.5`, decline resume after 24 hours and tell Claude to start a new GPT.
- For older/in-memory-cache-only models, warn after 10 minutes of inactivity and decline after 1 hour.
- Do not silently fall back to a fresh session from `send_gpt_agent_message`. If the cache gate declines, return `isError: true`.
- Do not try to detect actual cache hits unless OpenAI/Codex exposes a reliable preflight signal.
- A warning does not block the resume. Include the warning in the tool result and continue with `--resume`.

### Finishing a background GPT

When a background job completes, its result/status files should be reconciled into the named GPT record the next time the MCP server handles a named-GPT request:

- `status`
- `sessionId`
- `updatedAt`
- `activeJobId` cleared or retained as last debug job

The result should say:

```text
GPT "Hooks Recon" finished.
To continue, use send_gpt_agent_message with to: "Hooks Recon".
Debug job_id: job_...
```

### Listing GPTs

`list_gpt_agents` should reconcile current-process named GPTs from job files, then return concise state. This is the normal status surface for Claude:

```json
[
  { "name": "Hooks Recon", "status": "completed", "last_job_id": "job_..." }
]
```

No raw prompts, raw `session_id`, or full filesystem paths in default list output.

## Compatibility

Do not delete existing job-tool implementation in the first change. Existing tests and manual debugging may rely on it. But default MCP exposure should be named-GPT-first: mutating/log job tools are debug surfaces, while read-only result retrieval is a normal product tool.

Existing resume mechanics can be reused internally, but the MCP-facing contract must change:

- `spawn_gpt_agent` creates a new named GPT.
- `send_gpt_agent_message` continues an existing named GPT.
- `spawn_gpt_agent` with an existing visible name errors instead of continuing.
- Debug job tools are hidden unless debug mode is explicitly enabled.

## Tests to add or update

Add focused tests in `scripts/mcp/gpt-agent.test.ts`:

1. `tools/list` exposes `spawn_gpt_agent`, `send_gpt_agent_message`, `list_gpt_agents`, and read-only result retrieval tools in normal mode, without mutating/log job debug tools.
2. `tools/list` exposes mutating/log job debug tools only when debug mode is explicitly enabled.
3. `spawn_gpt_agent` without a name creates a unique visible fallback name and does not use `description` as the name.
4. Duplicate `spawn_gpt_agent` name returns `isError: true`, does not resume, and does not create a second GPT, including concurrent foreground spawns.
5. `replace_existing: true` can explicitly rebind a bricked or unwanted name without making duplicate reuse implicit.
6. `send_gpt_agent_message` is the only normal continuation path.
7. `send_gpt_agent_message` resumes the reconciled `GptRecord.sessionId` for a completed GPT, not `conversations.json`.
8. `send_gpt_agent_message` to a running GPT returns busy, mentions `list_gpt_agents`, and does not queue or spawn another run, including concurrent foreground sends.
9. Background GPT completion is reconciled from job files when listing or sending a follow-up.
10. Debug job cleanup does not leave a named GPT permanently busy.
11. `list_gpt_agents` returns names/status without raw prompt text, raw `session_id`, or full paths.
12. Auto-generated names are unique within the current MCP process.
13. Existing global conversation mappings do not appear as named GPTs in a fresh MCP process and are not used for named-GPT continuation.
14. Existing mutating/log job-control implementation tests still pass when debug mode is enabled.

## Implementation traps

- Name reservation is required before any foreground or background work starts, but failed reservations must not brick names accidentally. Roll back startup failures that do not need to remain visible as named failed GPTs.
- Do not burn generated `GPT N` names merely by checking availability if the spawn is rejected before a record is created.
- Do not treat every reconciliation error as terminal. Missing job artifacts are different from partial JSON writes or transient read failures.
- A failed GPT with a `sessionId` is recoverable; a failed GPT without a `sessionId` is not continuable unless it is explicitly replaced.
- Background workers cannot mutate the parent in-memory registry. `list_gpt_agents` and `send_gpt_agent_message` are the reconciliation points.
- Hiding mutating/log job debug tools by default means normal busy/status wording must point to `list_gpt_agents`, not job mutation tools.

## Verification

Run:

```bash
cd /Users/pt/cat-code && bun test scripts/mcp/gpt-agent.test.ts
cd /Users/pt/cat-code && bun run build:dev:full
```

Also search for stale user-facing wording:

```text
conversation
job_id
one-shot
messageable
followup_tool
helper
resume
spawn/resume
spawn_gpt_agent
get_gpt_agent_job_status
get_gpt_agent_job_result
wait_for_gpt_agent_job
tail_gpt_agent_job_log
cancel_gpt_agent_job
cleanup_gpt_agent_job
```

Only change references that describe this MCP product surface. Do not rewrite unrelated one-shot/job language elsewhere.

## Settled review decisions

- Upstream Claude Code stdio MCP lifecycle verification is a pre-ship gate. If upstream exposes no stable session identifier, use MCP process lifetime with honest process-scoped wording.
- Default `send_gpt_agent_message` to foreground.
- Make duplicate visible names hard errors.
- Auto-generate simple unique names such as `GPT 1`. Keep `description` separate from generated names.
- Ship `spawn_gpt_agent`, `send_gpt_agent_message`, `list_gpt_agents`, and read-only result retrieval as normal-flow tools. Keep mutating/log job tools implemented but hidden behind debug mode.
- Make `list_gpt_agents` the normal polling/status surface.
- Make the in-memory GPT registry the source of truth for named GPTs; do not use `conversations.json` for named-GPT continuation.
- Prompt-cache freshness gating is in scope.
- `replace_existing: true` may replace only terminal/non-running GPTs; running GPT replacement is out of scope.
