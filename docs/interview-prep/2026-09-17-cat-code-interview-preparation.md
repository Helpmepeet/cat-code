# Cat Code Interview Preparation

This is the main study index for explaining Cat Code in the Skooldio AI
Engineer interview. Study one topic at a time. Do not try to memorize every
subsystem at once.

## The central idea

Cat Code exists because I wanted to own a customizable coding-agent harness. I
wanted to understand, configure, and improve the components inside the agent
rather than treat the coding assistant as a black box.

Cat Code started as a fork of Claude Code and has three major additions:

1. GPT model support through Codex subscription accounts.
2. A multi-account system that selects between Codex accounts to share usage.
3. A production Electron desktop application for managing coding sessions.

## Short interview introduction

> Cat Code is my fork of Claude Code. I built it because I wanted to own and
> understand a complete coding-agent harness, including model routing, context,
> tools, permissions, and sessions. I added support for GPT models through
> Codex subscription accounts, a multi-account system that distributes usage,
> and an Electron desktop application for managing coding sessions.

## Study order

1. [Why Cat Code exists](2026-09-17-cat-code-purpose.md)
2. [The three major additions](2026-09-17-cat-code-major-additions.md)
3. [How Cat Code fits the Skooldio role](2026-09-17-skooldio-role-fit.md)

More topic files will be added only when we reach them. Likely future topics
include the engine loop, Codex provider integration, the multi-account system,
the Electron desktop architecture, tools and permissions, multi-agent sessions,
`apply_patch`, Auto Mode, and failure recovery.

## Interview rule

For every feature, prepare four answers:

1. What problem did it solve?
2. How does it work at a high level?
3. What difficult engineering decision did I make?
4. What tradeoff or limitation remains?
