# Cat Code's Three Major Additions

## 1. GPT models through Codex accounts

The original harness was designed around Claude. Cat Code changes the provider
path so the same coding-agent experience can also run GPT models using Codex
subscription accounts.

The important interview point is not simply that Cat Code can call another
model. The harness must translate provider behavior while preserving the
agent's prompts, messages, tools, streaming, and session behavior.

## 2. Multiple Codex accounts

Cat Code can maintain multiple Codex accounts instead of relying on only one.
It contains selection logic that chooses an account so usage can be shared
across the pool.

The high-level problem is:

```text
One account
  -> limited usage
  -> work stops when the limit is reached

Account pool
  -> select an available account
  -> distribute usage
  -> continue work when another account is constrained
```

The detailed selection, locking, usage, and recovery logic belongs in its own
study topic.

## 3. Electron desktop application

The desktop application is one of Cat Code's largest additions. It provides a
visual way to create, restore, inspect, and manage coding sessions.

The desktop is not a replacement for the engine. It runs the real Cat Code
engine behind a desktop interface, while adding session supervision, process
isolation, persistence, and UI controls.

## Combined interview answer

> Cat Code has three major additions over its starting point. First, I adapted
> the harness to run GPT models through Codex subscription accounts. Second, I
> built a multi-account system that can share usage across several Codex
> accounts. Third, I built an Electron desktop application that makes sessions
> easier to manage while still using the real coding-agent engine underneath.
