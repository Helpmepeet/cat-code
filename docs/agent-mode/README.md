# Agent Mode

Agent Mode is the orchestration-focused session type in Cat Code. It feels like normal chat but the model always operates as an orchestrator: it delegates work to subagents, runs independent work streams in parallel, and drives tasks end to end when you ask it to.

## Starting a session

```
/agent
```

Starts a fresh Agent Mode session with a clean conversation. Any text after `/agent` is submitted as the first message immediately.

```
/agent refactor the auth module to use the new token shape
```

```
cat-code --agent-mode
```

Starts the CLI directly in Agent Mode from the command line.

---

## How it differs from normal chat

In normal chat the model does everything inline in one context window. In Agent Mode the model acts as an orchestrator that manages workers:

- **Delegates earlier.** Substantial implementation work, broad codebase investigation, and independent review are handed off to subagents instead of done inline.
- **Runs work in parallel.** Independent work streams are spawned concurrently by default when there is no shared mutable state between them.
- **Drives end to end when asked.** If you say "finish this", "handle this end to end", "go do it", or similar, the orchestrator owns the task until it is done or blocked, without stopping to ask for step-by-step approval.
- **Stays collaborative otherwise.** Without an explicit ownership signal the orchestrator works with you, not around you.
- **Verifies before reporting done.** Meaningful code changes must be backed by evidence — build output, test results, typecheck, or targeted checks — not just the worker saying it worked.

The conversation surface is the same. There is no forced planning gate, no mandatory approval step before every task, no workflow console.

---

## The orchestrator

The main thread is always the orchestrator. It:

- Talks with you directly — all user-facing communication goes through it
- Plans inline, never delegating planning to a worker
- Synthesises worker findings before deciding the next step
- Decides when a task is complete or genuinely blocked
- Does small obvious edits itself when delegating would cost more than it saves

The orchestrator does not narrate its internal process. It keeps you informed at meaningful moments: when it clarifies the objective, when the direction changes, when it needs your approval, when work is done with evidence, or when it hits a real blocker.

---

## Workers

Two built-in worker roles are spawned by the orchestrator when needed.

### Coding worker

Full read/write/run access scoped to the assigned task.

**Tools available:** Bash, Read, Edit, Write, Patch, Glob, Grep, Agent (Explore only), ask\_orchestrator

The coding worker can spawn the Explore agent when it needs deeper codebase investigation. It cannot spawn other coding or verification workers — that decision belongs to the orchestrator.

When done, it returns a compact handoff:

```
status: done | blocked

One sentence summary of what changed.

Changed files:
- path/to/file.ts — what changed

Checks run:
- bun run build: pass
- bun test src/auth: pass

Unresolved / blockers: (omitted if none)
```

### Verification worker

Read-only. Spawned by the orchestrator after non-trivial implementation batches. Small or obvious changes are reviewed inline by the orchestrator instead.

**Tools available:** Bash, Read, Glob, Grep, ask\_orchestrator

It runs three checks in order:
1. **Design vs code** — did the implementation match what was asked? Explicit comparison, not just "does it work".
2. **Correctness** — build, tests, typecheck. Tool output counts more than code-reading judgments.
3. **Code review** — obvious quality issues, scope creep, style divergence. Lightweight, not a full re-implementation pass.

It returns a compact verdict:

```
verdict: pass | fail | warn

One sentence summary.

Evidence:
- Design vs code: matches the requested change
- Correctness: build pass, 12 tests pass
- Code review: clean, no scope creep

Issues: (omitted if verdict is pass)
1. [HIGH] ...

Recommended direction: fix | re-plan | block
```

The verification worker reports to the orchestrator only — it never communicates with you directly.

### Explore agent

Used directly by the orchestrator or coding worker for broad codebase investigation. Not a separate Agent Mode worker — it is the same Explore agent available in normal chat.

---

## The ask\_orchestrator tool

Workers have access to `ask_orchestrator`, a tool that routes a message back to the orchestrator rather than to you. Workers use it when:

- The task is ambiguous in a way that changes what to implement
- Required context is missing and cannot be inferred from the codebase
- They are stuck with concrete evidence and cannot continue safely

Three signal kinds:
- `question` — a clarifying question before proceeding
- `context` — a request for missing context
- `blocked` — the worker cannot continue; includes evidence

The orchestrator decides whether to resolve it itself or surface it to you.

---

## When the orchestrator asks for your approval

The orchestrator does not ask for approval on every task. It asks when:

- An action is destructive or hard to reverse (deleting files, dropping tables, force-pushing)
- Shared state would be modified in a way that affects other users or systems
- The scope or approach has materially shifted from what you described
- A permission boundary needs to be broadened
- Plan mode is being used for a heavier planning pass

For everything else it proceeds and reports results when done.

---

## Context across compaction

When the conversation runs long and context is compacted, Agent Mode preserves run-critical state in the summary: the current objective, approved plan summary, phase, latest verifier verdict, handoff block, open questions, and next action. After compaction the orchestrator reconstructs its state silently from this and continues without asking you where things left off.

---

## Customising worker behaviour with role files

Place a Markdown file at `.cat-code/roles/implementor.md` or `.cat-code/roles/verifier.md` in your project. Its contents are injected into the respective worker's system prompt at every spawn alongside the built-in role prompt.

Use this for repo-specific conventions the worker should always follow — not low-level implementation detail, but stable rules and constraints.

```markdown
# Implementor role notes

Path: .cat-code/roles/implementor.md

- Always run `bun run build:dev:full` before reporting done.
- Do not touch src/constants/prompts.ts without explicit instruction.
- New tools go in src/tools/<ToolName>/ following the existing pattern.
- Match the surrounding file's import style — no mixing ESM and CJS.
```

The path comment at the top lets the worker know where to write learnings that should persist across sessions.

---

## Shared context files

Any `.md` file placed under `.cat-code/context/` is listed in every worker's briefing at spawn. Workers read whichever files are relevant to their task. Content is not injected automatically — only the file list is shown, keeping context lean.

Use this for stable, high-level domain knowledge:

```
.cat-code/
  context/
    auth.md        # OAuth flow, session token shape, trust model
    api.md         # External API surface, rate limits, error codes
    frontend.md    # Component conventions, state management patterns
    database.md    # Schema overview, migration conventions
```

Keep these files focused and relatively stable. If a file needs to be updated after every PR it is probably too low-level for this layer. Implementation detail belongs in code; architecture decisions and conventions belong here.

---

## MCP tools in workers

If you have MCP servers connected to your session, workers also get access to those MCP tools. The orchestrator's briefing to each worker lists the available MCP servers by name.

---

## Ending a session

There is no special exit command. `/clear` starts a fresh session. The mode indicator in the UI shows whether you are currently in Agent Mode.

---

## Reference

| Thing | Where it lives |
|---|---|
| Orchestrator system prompt | `src/agent-mode/orchestratorPrompt.ts` |
| Worker role prompts and tool lists | `src/agent-mode/rolePrompts.ts` |
| Role file and context file injection | `src/agent-mode/roleFiles.ts` |
| ask\_orchestrator tool | `src/tools/AskOrchestratorTool/` |
| `/agent` command | `src/commands/agent/` |
| Agent Mode session guidance injected each turn | `src/constants/prompts.ts` → `getAgentModeSessionSpecificGuidanceSection` |
| Compaction continuity | `src/services/compact/prompt.ts` → `AGENT_MODE_COMPACT_APPENDIX` |
