# Plan: Prompt System for Two Deployments

**Status:** Draft v2 — 2026-04-04
**Branch:** codex/prompt-identity-shift
**Depends on:** newInstruction.ts (already merged into branch)
**Reference:** AGENT_IDENTITY.md (defines who the agent is)

---

## Framing

This is not "two modes." It is two deployments of the same binary with different configurations.

- **Coding deployment** — main Mac, interactive, started when you want to code. Behaves as it does today.
- **Agent deployment** — server Mac, always-on, autonomous. Runs 24/7 whether you are present or not.

You never switch between them at runtime. You start one or the other. The server Mac is always running the agent deployment. The main Mac runs the coding deployment when you sit down to work.

They share a backend: same tools, same memory system, same auth, same provider logic, same build system. But the prompt layer — identity, behavioral framing, and task assumptions — is different.

---

## What the Prompt System Needs to Do

### 1. Select the prompt set at startup

A single env var determines which prompt set loads:

```
AGENT_DEPLOYMENT=agent    → agent prompt set
AGENT_DEPLOYMENT=coding   → coding prompt set (default)
(unset)                   → coding prompt set
```

This is read once at startup. There is no runtime toggle. No `/mode` command. No session-level state management.

### 2. Build a different system prompt for each deployment

**Coding deployment** — exactly what exists today. `getSystemPrompt()` returns the current prompt. No changes.

**Agent deployment** — a new `getAgentSystemPrompt()` replaces the default prompt entirely. It draws from AGENT_IDENTITY.md for identity and behavioral principles, and shares infrastructure sections with the coding prompt.

### 3. Share what can be shared

The prompt is built from sections (see `src/constants/prompts.ts`). Many sections are deployment-agnostic:

| Section | Shared? | Notes |
|---|---|---|
| System (tool permissions, reminders, hooks) | Yes | Identical |
| Actions (careful execution, reversibility) | Yes | Identical |
| Using your tools (dedicated tools, parallelism) | Yes | Identical |
| Tone and style | Mostly | Agent may relax "no emoji" default |
| Session-specific guidance (subagents, skills) | Yes | Identical |
| Memory | Yes | Same system, but agent treats it as identity-critical |
| Env info | Yes | Identical |
| Language | Yes | Identical |
| MCP instructions | Yes | Identical |
| Output efficiency | Mostly | Agent adapts for general conversation |
| Intro / identity | No | Completely different |
| Doing tasks | No | Completely different |

### 4. Replace what must be replaced

**Identity prefix** (`src/constants/system.ts`):
- Coding: "You are free-code, a terminal-native coding agent..."
- Agent: New prefix from AGENT_IDENTITY.md — peer, not tool, always-on, autonomous

**Intro section** (`getSimpleIntroSection` in `src/agent/prompt.ts`):
- Coding: "helps users with software engineering tasks"
- Agent: General-purpose personal agent. Research, planning, automation, communication, and coding.

**Doing tasks section** (`getSimpleDoingTasksSection` replaced in `src/agent/prompt.ts`):
- Coding: "The user will primarily request you to perform software engineering tasks" + all coding-specific guardrails
- Agent: Replaced with agent behavioral defaults from AGENT_IDENTITY.md:
  - Consider whether the request is right, not just how to do it
  - Push back when something seems wrong
  - Work autonomously through task queue when not in conversation
  - Message the user when something finishes or needs input
  - Coding guardrails still available but not foregrounded — triggered by task context, not assumed

**URL restriction**:
- Coding: "NEVER generate or guess URLs... unless for programming"
- Agent: Relaxed — agent handles research, web search, general tasks

**Subagent prompts** (`generalPurposeAgent.ts`, `exploreAgent.ts`):
- Coding: Current framing
- Agent: Adjusted identity prefix — "You are a subagent for [agent name]" not "for Claude Code"

---

## What Does NOT Change

- `src/QueryEngine.ts` — no plumbing change; agent prompt is just a different `defaultSystemPrompt`
- `src/services/api/claude.ts` — no API-level change
- `src/context.ts` — context injection works the same
- `src/utils/claudemd.ts` — CLAUDE.md loading unchanged
- `src/utils/systemPrompt.ts` — `appendSystemPrompt` and `overrideSystemPrompt` still work
- Coordinator mode — independent; coordinator prompt still wins when active
- Tool registry — all tools available in both deployments
- Auth, cache, provider logic — unchanged

---

## Files to Change

### New files

| File | Purpose |
|---|---|
| `src/agent/deployment.ts` | Reads `AGENT_DEPLOYMENT` env var, exports `isAgentDeployment()` predicate |
| `src/agent/prompt.ts` | Agent system prompt builder: `getAgentSystemPrompt()` |

### Modified files

| File | Change |
|---|---|
| `src/constants/system.ts` | Add agent deployment identity prefixes |
| `src/constants/prompts.ts` | `getSystemPrompt()` branches on `isAgentDeployment()`: coding path unchanged, agent path calls `getAgentSystemPrompt()` |
| `src/tools/AgentTool/built-in/generalPurposeAgent.ts` | Branch subagent identity on deployment |
| `src/tools/AgentTool/built-in/exploreAgent.ts` | Branch subagent identity on deployment |

### Not needed (removed from previous plan)

| Previously planned | Why removed |
|---|---|
| `src/constants/agentMode.ts` | No runtime mode state to manage — env var check lives in `src/agent/deployment.ts` |
| `src/commands/mode/mode.tsx` | No `/mode` command — deployment is set at startup |
| Changes to `src/commands.ts` | No new command to register |

---

## Agent Prompt Structure

The agent prompt follows this section order. Sections marked "shared" use the same function from `prompts.ts`.

```
1. Identity          — NEW: who you are (from AGENT_IDENTITY.md)
2. System            — shared: tool permissions, reminders, hooks
3. Behavioral defaults — NEW: how you act (from AGENT_IDENTITY.md)
4. Actions           — shared: careful execution, reversibility
5. Using your tools  — shared: dedicated tools, parallelism
6. Tone and style    — shared with minor adjustments
7. Output efficiency — shared with minor adjustments
8. [Dynamic sections] — shared: memory, env, language, MCP, etc.
```

Sections 2, 4, 5 are identical calls to existing functions.
Sections 1, 3 are new.
Sections 6, 7 are shared functions with deployment-aware branching.

---

## Implementation Order

1. **`src/agent/deployment.ts`** — env var check, `isAgentDeployment()` (smallest, unblocks everything)
2. **`src/agent/prompt.ts`** — the agent prompt (the hard creative work, informed by AGENT_IDENTITY.md)
3. **`src/constants/prompts.ts`** — branch `getSystemPrompt()` on deployment
4. **`src/constants/system.ts`** — add agent identity prefixes
5. **Subagent prompts** — branch generalPurpose and explore agents on deployment
6. **Test** — build, verify both deployments emit correct prompts via dump-prompts

---

## Open Questions

1. **Should the agent deployment have its own SOUL.md file?** A user-editable file at `~/.cat-code/SOUL.md` that only loads in agent deployment. Deferred for now — personality starts in `src/agent/prompt.ts`, extractable later.
2. **Which shared sections need agent-aware adjustments vs. being used as-is?** The tone and output efficiency sections may need minor branching. Determined during implementation.
3. **Agent name?** Deferred to Milestone 2. Agent deployment uses the existing binary name for now.

---

## What This Plan Does NOT Cover

- Technical architecture for task queue, cron, monitoring, messaging — deferred per AGENT_IDENTITY.md
- Milestone 2 (naming/branding)
- Milestone 3 (persistent memory beyond current system)
- New tools for agent deployment
- Mobile/remote interface
- How the binary is started differently on server Mac (launchd, etc.)
- Prompt caching strategy for Codex path (sticky sessions decision made separately)
