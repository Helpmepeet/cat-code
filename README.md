# Cat Code

**My personal desktop workspace for coding with AI.**

Cat Code is the app I’m building around the way I want to work with coding
agents: several sessions in one place, peers that can talk to each other, and
Auto mode to keep work moving with fewer approval interruptions. It started as
a Claude Code fork and has grown into an Electron desktop application with its
own interface and workflows.

![Cat Code desktop welcome screen with its neon cat, project selector, and account usage overview](assets/readme/desktop.jpg)

## A home for my coding sessions

The application is the focus of this project. Sessions live in tabs and a
project sidebar, with split views for working across conversations. Tool calls,
file edits, command output, and responses appear together in the transcript.
Saved history makes it possible to return to earlier work.

Model and reasoning controls sit beside the composer. The welcome screen brings
project selection and account usage into the same workspace, and the interface
has a little personality of its own. There are cats.

## Sessions that talk to each other

Peer messaging is one of the features I most want to highlight. Each desktop
session has a name that other sessions can address. Agents can create peers,
find existing ones, read or search their conversations, and send them messages.

That makes workflows like these possible:

- One session implements a change while another reviews the approach.
- A session asks a peer a focused question and receives the answer in its conversation.
- Separate investigations share findings as the work develops.

Each peer keeps its own conversation. Messages between sessions appear in the
transcript, so I can follow the exchange and move between the sessions involved.

## Auto mode

Auto mode reduces the need to approve individual tool actions. Actions that
aren’t already covered by permission rules go through a safety classifier,
which evaluates them in the context of the conversation and configured rules.
Work can continue when approved; actions that don’t pass the checks can still
be blocked or require my attention.

The app also exposes other permission modes, including asking for approval,
automatically accepting edits, and planning before making changes. Auto mode’s
availability depends on the selected model and configuration.

## Making it my own

Appearance controls, syntax highlighting, skills, custom agents, hooks, plugins,
and MCP integrations let me shape both the interface and the agent’s workflow.

![Cat Code appearance settings with a syntax-highlighted Python preview and dark appearance selected](assets/readme/appearance.jpg)

*Screenshots captured from the running desktop app. The interface is still evolving.*

## Run from source

This is a personal project run from a trusted checkout. With Git and
[Bun](https://bun.sh) 1.4 or newer installed:

```sh
bun install
bun install --cwd app
bun run --cwd app dev
```

The desktop uses the local coding-agent engine. Claude and Codex-backed GPT
models use their respective authentication paths; GPT requests use
ChatGPT/Codex subscription OAuth. The app includes account management surfaces.

The terminal interface is also available:

```sh
bun run build:dev:full
./cli-dev
```

## Inside the project

The desktop uses Electron, React, and TypeScript, with a Bun engine process for
each live session. Sessions and settings are stored locally; model requests go
to the configured provider.

- [`app/`](app/): desktop application.
- [`src/`](src/): coding-agent engine and shared runtime.
- [Workspace map](docs/maps/WORKSPACE_MAP.md): guide to the codebase.
- [Repository instructions](CLAUDE.md): development workflow and verification.

Cat Code is a private personal fork of Claude Code. This repository does not
provide a public installer, update channel, or redistribution license.
