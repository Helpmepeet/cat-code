# Why Cat Code Exists

## Main motivation

I wanted my own customizable coding-agent harness.

Using an existing coding assistant lets me complete tasks, but owning the
harness lets me understand and change how the assistant works internally. This
includes:

- Which model and provider handle a request.
- How instructions and repository context are assembled.
- Which tools the model can use.
- How tool inputs are validated and approved.
- How conversations and sessions are stored.
- How failures, limits, and recovery are handled.

Claude Code provided a strong starting point. Forking it let me study a working
agent system and then change the parts that mattered to me.

## What "agent harness" means

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

## Interview answer

> I started Cat Code because I wanted to understand and control the full
> coding-agent loop. I did not want the agent to be a black box where I could
> only change the prompt. By owning the harness, I can configure model routing,
> context construction, tools, permissions, session behavior, and recovery.
> Forking Claude Code gave me a mature base that I could study and extend.

## Important distinction

The motivation and the resulting features are different:

- Motivation: ownership, understanding, and configurability.
- Resulting features: Codex support, multiple Codex accounts, and the desktop
  application.
