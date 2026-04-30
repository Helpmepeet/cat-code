# Session Observability Improvements

**Status:** Planned  
**Origin:** Post-mortem on session `9a993deb-4320-426b-aa67-c8579f17da54` (2026-04-16) where a subagent stalled for 11 hours. Root cause was a Codex stream that returned HTTP 200 but never sent chunks, with no watchdog to detect it. Investigation was slow due to multiple observability gaps documented below.

---

## How to find session files (context for future sessions)

Cat-code stores sessions in `~/.cat-code/projects/`, NOT `~/.claude/projects/`. The `~/.claude/` path is where Claude Code (upstream) stores its sessions. Cat-code overrides the config home via `getClaudeConfigHomeDir()` in `src/utils/envUtils.ts`, which returns `~/.cat-code` by default (or `CLAUDE_CONFIG_DIR` if set).

Session files are JSONL at:
```
~/.cat-code/projects/<sanitized-cwd>/<session-id>.jsonl
```

Subagent files are nested under:
```
~/.cat-code/projects/<sanitized-cwd>/<parent-session-id>/subagents/agent-<hash>.jsonl
~/.cat-code/projects/<sanitized-cwd>/<parent-session-id>/subagents/agent-<hash>.meta.json
```

The `.meta.json` contains `{ agentType, description }` — open it to identify which subagent is which before reading the full JSONL.

For the cat-code project specifically, the project dir is `-Users-pt-cat-code`, so sessions live at:
```
~/.cat-code/projects/-Users-pt-cat-code/<session-id>.jsonl
```

---

## How to read a session JSONL

Each line is a JSON object. The structure is not a flat sequence of turns — it is a tree. Key fields:

- `type` — `user`, `assistant`, `system`, or internal types like `file-history-snapshot`, `last-prompt`, `title`, `summary`
- `message.role` — `user` or `assistant`
- `message.content` — array of content blocks: `text`, `tool_use`, `tool_result`
- `isSidechain: true` — marks entries that are parallel branches of the same turn (e.g. multiple tool calls dispatched simultaneously). These share the same `message.id` but have different `uuid` and `parentUuid`.
- `parentUuid` — links each entry to its parent in the conversation tree
- `agentId` — present on subagent entries
- `sourceToolAssistantUUID` — on tool result entries, points back to the assistant turn that issued the tool call
- `message.usage.input_tokens: 0` with `stop_reason: null` — phantom entries. These are pre-API-call splits logged before the actual API response arrives. Safe to ignore for reading purposes.
- `message.stop_reason: tool_use` — the API response requested tool calls
- `message.stop_reason: end_turn` — the API response was a final answer

To reconstruct a readable transcript, filter out `isSidechain: true` entries with `input_tokens: 0`, then follow `parentUuid` chains. The existing `enrichLogs` and `getSessionFilesLite` functions in `src/utils/sessionStorage.ts` already do some of this for the resume picker.

A quick Python snippet that was useful during the investigation:
```python
import sys, json
lines = open('path/to/session.jsonl').readlines()
for line in lines:
    d = json.loads(line)
    t = d.get('type','')
    ts = d.get('timestamp','')[11:19]
    role = d.get('message',{}).get('role','')
    content = d.get('message',{}).get('content', [])
    if not isinstance(content, list): continue
    for c in content:
        if c.get('type') == 'text':
            print(f'[{ts}] {role.upper()}: {c["text"][:200]}')
        elif c.get('type') == 'tool_use':
            print(f'[{ts}] TOOL_USE: {c["name"]} {str(c.get("input",""))[:150]}')
        elif c.get('type') == 'tool_result':
            print(f'[{ts}] TOOL_RESULT: {str(c.get("content",""))[:150]}')
```

---

## What happened in session 9a993deb (the stall incident)

**Timeline:**
- `15:32` — Session started implementing agent-mode-aware compaction
- `15:43` — Build passed, implementation complete
- `15:45:02` — User said "spawn 1 subagent to audit your code"
- `15:45:25` — Parent spawned audit subagent (`agent-a9d1aa01f9f6e6f9e`) using `gpt-5.4` (Codex/OpenAI path)
- `15:45:25–15:46:31` — Subagent completed 3 rounds of parallel tool calls (29 log entries total)
- `15:46:31` — Subagent received its last two tool results and was ready to make its final API call
- **Final API call sent to Codex backend, never returned**
- Parent session waited 11 hours for the Agent tool result

**Root cause:**
The Codex backend returned HTTP 200 with `Content-Type: text/event-stream` immediately (so `withRetry` saw no error), then held the connection open without sending any SSE chunks. The `reader.read()` loop in `translateCodexStreamToAnthropic` blocked forever because there was no idle timeout watchdog on the Codex path (unlike `claude.ts` which has `STREAM_IDLE_TIMEOUT_MS`).

**What was already in place that didn't help:**
- `withRetry` — only catches errors thrown before/during stream header receipt (4xx/5xx status codes, connection errors). A hung stream body after HTTP 200 is invisible to it.
- `CodexAccountCapError` failover — only triggers on 429/401. Irrelevant here.
- `claude.ts` idle watchdog — exists but is only on the Claude API path, not Codex.

**Fix applied (already in codebase):**
- Added idle watchdog to `translateCodexStreamToAnthropic` in `src/services/api/codex-fetch-adapter.ts`
- 90s timeout (configurable via `CLAUDE_STREAM_IDLE_TIMEOUT_MS`)
- On timeout: cancels `reader` AND `codexResponse.body` (to close the TCP connection, not just the reader)
- Throws via `controller.error()` so the error surfaces to `withRetry` as a retryable failure rather than being silently embedded as text in the stream

---

## Problems to solve

### 1. Session discovery is hard

Given only a session ID, there is no fast way to locate the file. Had to read source code to find the storage location.

**What was tried and failed:**
- `~/.claude/projects/` — this is the upstream Claude Code path, not cat-code
- Searching worktree project dirs — not there either
- `find ~/.claude/ -name "9a993deb*"` — empty

**What worked:** Reading `src/utils/envUtils.ts` → `getClaudeConfigHomeDir()` → `~/.cat-code/` then searching there.

**Relevant code:**
- `src/utils/envUtils.ts` — `getClaudeConfigHomeDir()`
- `src/utils/sessionStorage.ts` — `getProjectsDir()`, `getTranscriptPath()`

---

### 2. Subagent sessions are not linked from the parent

When a parent session spawns a subagent, there is no entry in the parent JSONL pointing to the subagent file. The parent log shows an `Agent` tool call was dispatched at `15:45:25` and then nothing — no path, no link, no result ever written back.

Discovery required: knowing to look in `~/.cat-code/projects/<session-id>/subagents/`, listing the directory, reading `.meta.json` files to identify which subagent was which.

The subagent files themselves are named with opaque hashes (`agent-a9d1aa01f9f6e6f9e.jsonl`) — description is only in the `.meta.json` sidecar.

**Relevant code:**
- `src/tools/AgentTool/AgentTool.tsx` — where Agent tool dispatches and awaits
- `src/utils/sessionStorage.ts` — `getAgentTranscriptPath()` around line 257

---

### 3. No terminal state when a subagent fails or hangs

The hung subagent's log ends at entry 28 (of 29) with two tool results received. Entry 29 does not exist — the session just stops. No failure reason, no timestamp of when the process died, nothing. The parent log also has no record of how long it waited or why it never got a result.

To determine the hang point required: counting entries, checking `stop_reason` fields, verifying that the last two assistant entries had `input_tokens: 0` (phantom pre-call splits), and confirming no final assistant turn existed after the tool results came back.

**What the log looked like at the end:**
```
25 [15:46:31] assistant  stop=None  [Grep]       ← phantom, input_tokens=0
26 [15:46:31] assistant  stop=None  [Read]        ← phantom, input_tokens=0
27 [15:46:31] user                  [RESULT:...]  ← tool result received
28 [15:46:31] user                  [RESULT:...]  ← tool result received
                                                  ← nothing after this
```

**Relevant code:**
- `src/tools/AgentTool/AgentTool.tsx` — subagent lifecycle, where result is written back
- `src/utils/sessionStorage.ts` — writing to transcript

---

### 4. JSONL is not human-readable without a custom parser

Raw format requires manual parsing. Pain points:
- Parallel tool calls produce multiple entries with the same `message.id` but different `parentUuid` — looks like duplicate/corrupted data until you understand the sidechain model
- Phantom entries (`stop_reason: null`, `input_tokens: 0`) interspersed with real entries
- Tool calls and their results are in separate entries linked only by `tool_use_id` / `sourceToolAssistantUUID`
- Subagent entries are mixed in with main thread entries, distinguished only by `isSidechain: true` and `agentId`

Had to write ad-hoc Python (see snippet above) every time to get a readable view.

**Relevant code:**
- `src/utils/sessionStorage.ts` — `enrichLogs`, `getSessionFilesLite` already reconstruct some of this for the resume picker
- `src/commands/` — where slash commands live
