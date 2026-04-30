# Session Observability — Implementation Plan

**Source**: `docs/session-observability-improvements.md` (post-mortem on session `9a993deb`, 11-hour subagent stall).

**Critical framing**: the post-mortem was written *by an agent* that investigated the stall. The observability problems it lists are **agent pain**, not operator pain. The consumer of every fix below is the next agent — the resumed parent, a subagent dispatched to check on a prior session, or an investigation agent the operator spawns. No human is expected to grep JSONL by hand.

This means we are not building CLI tooling, pretty transcript renderers, or slash commands. We are writing *log entries the agent will read and act on*, and making those entries findable through the tools the agent already has (`Read`, `Grep`, `Glob`).

Design reference: `https://claude.com/blog/seeing-like-an-agent` — judge every surface by "will the next agent actually use this correctly, or gloss over it?"

---

## Design principles

1. **The consumer is an agent.** Every artifact must be producible and consumable with `Read` / `Grep` / `Glob` — no new tool, no CLI.
2. **In-band beats out-of-band.** Put information where the agent already looks (the parent JSONL, the resumed context). Don't require it to know about new files or paths.
3. **Imperative over informational.** When surfacing a stalled subagent, tell the agent to *decide*, don't just announce. Agents ignore FYI; they act on direct asks.
4. **Structured, greppable, stable.** Entry types share prefixes so one `Grep` enumerates them. Fields are stable across versions (no breaking renames).
5. **Don't redesign what works.** `enrichLogs`, `getSessionFilesLite`, `writeAgentMetadata`, the new Codex idle watchdog all stay.

---

## Scope

Fixes the four problems in the source doc, ranked by agent impact:

1. **Parent↔subagent linking** — the top-priority problem. A resuming agent currently cannot tell a subagent ever ran.
2. **Terminal state on failure/hang/kill** — needed to distinguish "still running" from "died silently."
3. **Session discovery from just an id** — needed when an investigation subagent is handed a session id.
4. **Readable transcripts** — *not* a new renderer. Just making the existing JSONL tractable to `Grep` + `Read`.

Out of scope: CLI subcommands, slash commands, new UI, transcript-rendering helpers, telemetry.

---

## Phase 1 — Parent↔subagent linking via log entries (primary fix)

### 1a. Two new entry types in `src/types/logs.ts`

Added to the existing `Entry` union. Names prefixed `subagent-` so `Grep 'type":\s*"subagent-'` enumerates both.

```ts
export type SubagentSpawnedMessage = {
  type: 'subagent-spawned'
  sessionId: string
  agentId: AgentId
  agentType: string
  description: string
  transcriptPath: string          // absolute path to agent-<id>.jsonl
  toolUseId: string               // links to the Agent tool_use block
  spawnedAt: string               // ISO timestamp
}

export type SubagentTerminalMessage = {
  type: 'subagent-terminal'
  sessionId: string
  agentId: AgentId
  toolUseId: string
  status: 'completed' | 'failed' | 'killed' | 'timeout' | 'stall-detected'
  reason?: string
  durationMs: number
  endedAt: string                 // ISO timestamp
  lastActivityAt?: string         // ISO — timestamp of the last entry in the subagent transcript, if stall-detected
}
```

### 1b. Emit spawn entries (`src/tools/AgentTool/AgentTool.tsx` and `runAgent.ts`)

Where `writeAgentMetadata` is already called (AgentTool.tsx:686, runAgent.ts:750), also append a `subagent-spawned` entry to the *parent* transcript via a new `appendSubagentSpawned` helper in `src/utils/sessionStorage.ts` (uses the existing `appendEntryToFile` path).

### 1c. Emit terminal entries from all finalization paths

Three existing terminal sites already emit `tengu_agent_tool_terminated` analytics: AgentTool.tsx:1024, AgentTool.tsx:1159 / :1236, and agentToolUtils.ts:676 / :701. At each site, also append a `subagent-terminal` entry to the parent transcript. Status mapping:
- success after `finalizeAgentTool` → `completed`
- `AbortError` catch → `killed`
- generic catch → `failed` (`reason = errorMessage(error)`)
- Codex idle watchdog path → `timeout` (detectable by `reason` matching `/idle timeout/i`)

### 1d. Extend `AgentMetadata` with back-pointer (`src/utils/sessionStorage.ts:264`)

```ts
export type AgentMetadata = {
  agentType: string
  worktreePath?: string
  description?: string
  parentSessionId?: string   // NEW — lets an agent reading a subagent .meta.json find its parent
  parentToolUseId?: string   // NEW
  spawnedAt?: string         // NEW — ISO
}
```

Populated at both `writeAgentMetadata` call sites. All fields optional; older metadata files remain readable.

### 1e. Parent-exit stall sweep (`src/utils/cleanupRegistry.ts`)

In-memory map `agentId → { startedAt, toolUseId, transcriptPath }` populated at spawn, cleared when the terminal entry is written. On process exit, for each map entry still present, read the last line of its transcript (using the existing `readFileTailSync` helper), then append a `subagent-terminal` with `status: 'stall-detected'`, `reason: 'parent-exited-without-result'`, and `lastActivityAt` from that tail read.

This is what closes the 11-hour gap: after the fix, even a SIGKILL on the parent leaves a terminal entry.

---

## Phase 2 — Agent-facing surface on resume

This is how the resumed agent *uses* Phase 1. Without this, the entries are just structured logs nobody reads.

### 2a. Detect stalled subagents during `sessionRestore.ts`

After the session loads, walk its entries once and build two sets:
- `spawned` — all `subagent-spawned` entries
- `terminated` — all `subagent-terminal` entries, keyed by `toolUseId`

Stalled set = `spawned \ terminated`. Cost is one pass; `enrichLogs` already iterates the entries.

### 2b. Inject a `<system-reminder>` into the resumed context (freshness-aware)

For each stalled subagent, the resumed parent receives a synthetic system message (in-memory, not persisted — no log bloat, no idempotency issues on repeated resume). The wording depends on how long ago the subagent was spawned: recent stalls (<24h) block the current turn; old stalls (>24h) are informational.

**Recent stall (`spawnedAt` within the last 24h) — hard-voice:**

```
<system-reminder>
A subagent spawned earlier in this session has no terminal entry. It may have
stalled, been killed, or is still running in the background.

  agentId: a9d1aa01f9f6e6f9e
  agentType: general-purpose
  description: audit your code
  spawnedAt: 2026-04-16T15:45:25Z
  transcript: /Users/.../subagents/agent-a9d1aa01f9f6e6f9e.jsonl
  toolUseId: toolu_01ABC...

Before responding to the user's next message, surface this to them and ask
which action to take: (1) re-dispatch a fresh Agent call with the same task,
(2) Read the subagent transcript to recover partial results, or (3) abandon
the prior subagent. Do NOT proceed with the user's current request until
they choose. Do not silently ignore.
</system-reminder>
```

**Old stall (`spawnedAt` older than 24h) — soft-voice:**

```
<system-reminder>
An old subagent from this session is unterminated (spawned N days ago).

  agentId: a9d1aa01f9f6e6f9e
  description: audit your code
  transcript: /Users/.../subagents/agent-a9d1aa01f9f6e6f9e.jsonl

Mention it to the user only if relevant to their current request. Otherwise
proceed normally.
</system-reminder>
```

Key agent-UX properties (hard-voice):
- **Overrides the default.** `Do NOT proceed with the user's current request until they choose.` The agent's default is to answer whatever the operator just asked. This line forces a surface-and-wait.
- **Three concrete actions**, named with the exact tools (`Agent`, `Read`).
- **Absolute transcript path** — `Read` takes absolute paths directly.

Soft-voice avoids the derail: old stalls shouldn't hijack a fresh task.

One reminder block per stalled subagent. If none are stalled, nothing is injected.

### 2c. Add a "session transcripts" section to the **system prompt**

**Placement decision**: this content belongs in the built-in system prompt (`src/constants/prompts.ts`), not in `CLAUDE.md` or `AGENTS.md`. Reason: the JSONL paths, `.meta.json` schema, and greppability are properties of **cat-code the product** — they apply to every cat-code session regardless of which project the agent is working in. `CLAUDE.md` is repo-scoped, so an agent debugging a stalled session from a different project wouldn't see it.

**How it gets wired in** (`src/constants/prompts.ts:553`): add one new `systemPromptSection('session_transcripts', ...)` to the `dynamicSections` array inside `getSystemPrompt()`. Since both parent and subagent system prompts flow through `getSystemPrompt()`, this single entry covers both — no separate edit needed for `src/tools/AgentTool/prompt.ts` (which is the Agent *tool description*, not the subagent's system prompt).

**Content of the section** — primes against the Python reflex, gives copy-pasteable examples, and includes the explicit `Glob path=` argument:

```
## Reading session transcripts

Cat-code session files are line-oriented JSONL. Use Grep with patterns on
the "type" or other fields — do NOT write a custom parser. The shape is stable.

Paths:

    ~/.cat-code/projects/<sanitized-cwd>/<session-id>.jsonl
    ~/.cat-code/projects/<sanitized-cwd>/<session-id>/subagents/agent-<hash>.jsonl
    ~/.cat-code/projects/<sanitized-cwd>/<session-id>/subagents/agent-<hash>.meta.json

Given a session id prefix, resolve the file with Glob — pass the projects
dir as the `path` argument, not the default cwd:

    Glob pattern="**/*9a993deb*.jsonl" path="~/.cat-code/projects/"

Common queries on a transcript:

    Grep '"type":"tool_use"'      # list tool calls
    Grep '"stop_reason"'          # find last API response boundary
    Grep '"type":"subagent-'      # enumerate spawn/terminal entries
    Grep '"tool_use_id":"toolu_'  # link a tool_result back to its tool_use

The subagent sidecar `.meta.json` contains:

    {
      "agentType": "general-purpose",
      "description": "audit your code",
      "worktreePath": "...",              // if spawned with isolation:"worktree"
      "parentSessionId": "...",           // who spawned this subagent
      "parentToolUseId": "...",           // Agent tool_use block in the parent
      "spawnedAt": "2026-04-16T15:45:25Z"
    }

Read .meta.json first when you want to know what a subagent was for or who
spawned it.
```

This is the mechanism that makes the rest of the plan land for the agent: every session gets the reading patterns in its context, priced once and cached thereafter.

**Token cost consideration**: the section is ~25 lines. It's cached by prompt caching after the first turn of each session, so the marginal cost is bounded. Worth it because it prevents the "write Python against our own JSONL" failure mode universally, not just for agents working in this repo.

---

## Phase 3 — Discoverability when an agent is handed a bare session id

When the operator says *"look at session 9a993deb"*, the agent needs to find the file. Currently this requires reading `src/utils/envUtils.ts` to learn the config path.

### 3a. (Folded into 2c)

The path structure, `Glob path=` guidance, and `.meta.json` schema are all part of the single `session_transcripts` system-prompt section defined in 2c. No separate surface — one section, one edit, one place to update if anything changes.

### 3b. Reverse index file (optional, only if 3a proves insufficient)

A single JSON file `~/.cat-code/projects/.index.json` with `{ sessionId: projectDir }` entries, updated on session create/finalize. Lets `Read` lookup an id without a `Glob` walk.

Defer until we measure whether 3a + `Glob` is fast enough. `Glob` over `~/.cat-code/projects/` is O(projects × sessions) — likely fine for <1000 sessions.

---

## Phase 4 — Deferred: stream lifecycle tracing

From the original plan. Only pursue if a future stall can't be explained by Phase 1–2 terminal entries. Gated behind `CLAUDE_STREAM_TRACE=1`.

---

## File-by-file change list

| File | Change | Phase |
|---|---|---|
| `src/types/logs.ts` | Add `SubagentSpawnedMessage` + `SubagentTerminalMessage` to `Entry` | 1a |
| `src/utils/sessionStorage.ts` | Add `appendSubagentSpawned`, `appendSubagentTerminal`; extend `AgentMetadata` | 1b, 1c, 1d |
| `src/tools/AgentTool/AgentTool.tsx` | Emit spawn entry at line 686; emit terminal entries at lines 1024, 1159, 1236 | 1b, 1c |
| `src/tools/AgentTool/runAgent.ts` | Emit spawn entry at line 750; pass parent pointers into `writeAgentMetadata` | 1b, 1d |
| `src/tools/AgentTool/agentToolUtils.ts` | Emit terminal entries at lines 676 (killed) and 701 (failed) | 1c |
| `src/utils/cleanupRegistry.ts` | Register stall sweep on parent exit | 1e |
| `src/utils/sessionRestore.ts` | Detect stalled subagents, inject `<system-reminder>` blocks | 2a, 2b |
| `src/constants/prompts.ts` | Add `systemPromptSection('session_transcripts', ...)` to `getSystemPrompt`'s `dynamicSections` — the JSONL-grep primer with copy-pasteable examples, explicit `Glob path=` argument, and `.meta.json` schema. Covers both parent and subagent prompts since both flow through `getSystemPrompt()`. | 2c (folds 3a) |

Eight files. No new entry points, no new CLI, no new slash commands, no new React components. Built-in system prompt gains ~25 lines (cached after first turn).

---

## Verification

Agent-perspective tests (what matters) come first:

1. **Fresh session resume after stall (recent, hard-voice).** Kill a running parent with SIGKILL while its subagent is mid-API-call. Immediately `/resume` the same session. Confirm the resumed agent's first turn receives the hard-voice `<system-reminder>` and surfaces the choice to the user *before* answering any new request — even if the user's resume message asks about something unrelated.
2. **Old stall (soft-voice branch).** Synthesize a `subagent-spawned` entry with `spawnedAt` 48h old and no terminal. Resume. Confirm the soft-voice reminder is used and the agent proceeds with the user's current request without derailing into forensic investigation.
3. **Investigation subagent.** Spawn an Agent with *"Investigate session 9a993deb and explain what happened."* Confirm it uses `Glob` with an explicit `path="~/.cat-code/projects/"` argument (not the cwd default), then `Grep '"type":"subagent-'` against the resolved file, without writing any Python-style parser.
4. **The original scenario end-to-end.** Codex 200 + hang → idle watchdog fires → subagent transcript ends with a `stop_reason: 'error'` entry → parent transcript receives `subagent-terminal` with `status: 'timeout'` within 90s. Resumed parent sees zero stalled-subagent reminders (terminal was written) but does see the `failed` status and can decide to retry.

Mechanical tests:
5. Unit: new entry types round-trip through `jsonStringify` / `parseJSONL`.
6. Regression: `enrichLogs` ignores unknown entry types for sessions that predate Phase 1 — no crashes on old logs.

**"Done" = an agent handed only the session id `9a993deb` reconstructs the post-mortem's key facts (which subagent, at what time, on what tool) in one turn, using only `Read` / `Grep` / `Glob`.**

---

## Resolved decisions (from the "no preference" answers — recommended options taken)

1. Terminal status kept as five distinct values: `completed | failed | killed | timeout | stall-detected`.
2. No backfill for old sessions. Agents investigating pre-Phase-1 sessions fall back to walking the `subagents/` subdir with `Glob` (path documented in `CLAUDE.md`).
3. No CLI surface. The original Phase 2 inspect subcommand is deleted from scope — its consumer was imagined, not real.
