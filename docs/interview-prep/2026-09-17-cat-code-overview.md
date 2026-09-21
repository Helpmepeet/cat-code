# Cat Code Interview Overview

This is the starting document for explaining Cat Code in the Skooldio AI
Engineer interview. It covers the purpose and main features of the project.
Detailed technical subsystems can have separate study files later.

## Why Cat Code exists

I wanted my own customizable coding-agent harness. I wanted to understand,
configure, and improve the components inside a coding agent rather than treat
the agent as a black box.

Using an existing coding assistant lets me complete tasks, but owning the
harness lets me control:

- Which model and provider handle a request.
- How instructions and repository context are assembled.
- Which tools the model can use.
- How tool inputs are validated and approved.
- How conversations and sessions are stored.
- How failures, usage limits, and recovery are handled.

Claude Code provided a strong starting point. Forking it let me study a working
agent system and extend the parts that mattered to me.

## What an agent harness is

The LLM is only one component. The harness is the software around the model
that turns it into a useful coding agent.

```text
User request
  -> instructions and context
  -> model
  -> tool decisions
  -> permission checks
  -> tool execution
  -> result returned to the model
  -> answer to the user
```

The harness controls this full loop.

## Cat Code's three major additions

### 1. GPT models through Codex accounts

The original harness was designed around Claude. Cat Code changes the provider
path so the same coding-agent experience can run GPT models through Codex
subscription accounts.

The important engineering work is not simply calling another model. The
harness must adapt provider behavior while preserving prompts, messages, tool
calls, streaming responses, and session behavior.

### 2. Multiple Codex accounts

Cat Code can maintain a pool of Codex accounts instead of relying on only one.
It contains selection logic that shares usage across those accounts.

```text
One account
  -> limited usage
  -> work stops when the limit is reached

Account pool
  -> select an available account
  -> distribute usage
  -> continue work when another account is constrained
```

The detailed selection, locking, usage, and recovery mechanisms belong in a
future subsystem study.

### 3. Electron desktop application

The Electron desktop application is one of Cat Code's largest additions. It
provides a visual way to create, restore, inspect, and manage coding sessions.

The desktop does not replace the coding-agent engine. It runs the real Cat Code
engine behind a desktop interface while adding session supervision, process
isolation, persistence, recovery, and UI controls.

For a detailed explanation of model context, messages, tools, interrupts, and
skills, see [What the Model Sees](./2026-09-17-what-the-model-sees.md).

For the evolution from inherited full-history replacement to Cat Code's current
prefix-preserving design, see [Compaction](./2026-09-18-compaction.md).

For how Cat Code balances autonomy and safety through an automated two-stage
security monitor, see [Auto Mode](./2026-09-18-auto-mode.md).

For collaboration between independent desktop sessions, including identity,
delivery, loop protection, and compaction provenance, see
[Peer Sessions](./2026-09-18-peer-sessions.md).

## Short interview introduction

> Cat Code is my fork of Claude Code. I built it because I wanted to own and
> understand a complete coding-agent harness, including model routing, context,
> tools, permissions, and sessions. I added support for GPT models through
> Codex subscription accounts, a multi-account system that distributes usage,
> and an Electron desktop application for managing coding sessions.

## How Cat Code fits the Skooldio role

The Skooldio AI Engineer role focuses on turning LLM capabilities into reliable
systems that people can use in real workflows. Cat Code provides evidence for
several parts of that role.

| Skooldio is looking for | Cat Code evidence |
| --- | --- |
| Agentic AI and tool use | A coding agent that selects and executes tools |
| Repeatable workflows | A structured agent loop rather than one-off prompts |
| Guardrails and quality gates | Tool validation, permissions, and Auto Mode |
| Error analysis and recovery | Connection recovery and account failover work |
| Internal tooling | The reusable harness and Electron desktop application |
| Monitoring and debugging | Session events, diagnostics, and runtime state |
| Production engineering | Persistence, process isolation, testing, and recovery |

Supporting experience from my other work also matters:

- The LLM evaluation capstone supports the evaluation part of the role.
- Rabbit Care automation supports API, data, SQL, and business-workflow
  integration.
- FileSender supports product engineering, validation, temporary state, and
  cleanup.

## Honest gaps to prepare

Cat Code is not primarily a RAG project. I need separate preparation for:

- RAG architecture and evaluation.
- Embeddings and vector databases.
- FastAPI service design.
- LangChain and LlamaIndex concepts.
- AI quality, latency, and cost metrics.

I should connect Cat Code's production-agent engineering to these topics
without claiming that Cat Code already demonstrates every item in the job
description.

## How to prepare each future subsystem

For every feature, prepare four answers:

1. What problem did it solve?
2. How does it work at a high level?
3. What difficult engineering decision did I make?
4. What tradeoff or limitation remains?

Future subsystem files may cover the engine loop, Codex provider integration,
the multi-account system, the Electron desktop architecture, tools and
permissions, multi-agent sessions, `apply_patch`, Auto Mode, and failure
recovery.
