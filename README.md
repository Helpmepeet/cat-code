# Cat Code

Cat Code is a private, local-first coding-agent runtime developed from a Claude
Code fork. Its primary product is the terminal engine: a persistent interactive
agent for working in source repositories and local development environments.

This is source software for a personal system, not a hosted product or public
distribution. The Electron desktop application is a substantial developer
preview, but the terminal engine is the supported day-to-day surface in this
repository.

## What it does

The terminal engine provides:

- Interactive terminal sessions and non-interactive prompt execution.
- Multi-turn tool use for files, patches, shells, search, web fetch, notebooks,
  tasks, and other build-enabled integrations.
- Permission rules, interactive approval, path validation, sandbox integration,
  and lifecycle hooks around tool execution.
- Durable, project-scoped JSONL transcripts that can be resumed or forked.
- Context compaction, session state, and separate durable memory for normal
  local sessions.
- Model selection and reasoning-effort controls across supported providers.

Tool availability is intentional rather than universal. Build features,
environment checks, session mode, configured permissions, deny rules, and
sandbox policy determine what a model can see and call. MCP tools and resources
join the normal tool pool and may be discovered on demand through tool search.

### Models and providers

Cat Code supports Anthropic model routing through first-party Anthropic
authentication, AWS Bedrock, Google Vertex AI, and Microsoft Foundry.

It also supports the Codex-backed GPT models in its current catalog through
ChatGPT/Codex subscription OAuth. Codex credentials are managed through a local
account pool, with request-time account selection and refresh handling. A
`gpt-*` model name routes that request to the Codex/OpenAI path regardless of
the session's default provider.

There is **no generic OpenAI API-key route for GPT model requests**. Use the
interactive `/login` flow to add a ChatGPT/Codex subscription account, then use
`/accounts` to inspect or switch configured accounts. The read-only
`cat-code codex status --json` command reports an advisory pool observation; it
does not reserve capacity or make a live request route decision.

### Workers, sessions, and workflow

The `Agent` tool delegates bounded work to specialized local workers. A worker
can run in the foreground or background, use a selected model and policy, be
resumed from its retained transcript, and, when requested, work in an isolated
Git worktree. Shell tasks and agent tasks have explicit lifecycle and stop
controls.

The earlier **Agent Mode** is retired. Current terminal orchestration uses
delegated workers and tasks. The desktop preview adds a distinct peer-session
model: peers are independently addressable desktop sessions that can create,
list, read, and message one another through the host-controlled request plane.

### Configuration and extension

Cat Code supports:

- **Skills**: reusable instruction workflows, including slash-command and
  model-invocable surfaces when their metadata permits it.
- **Custom agents**: local definitions that set prompts, tools, models, effort,
  permissions, hooks, MCP requirements, and optional worktree isolation.
- **Hooks**: commands that run around session and tool lifecycle events.
- **MCP**: configured external tools, resources, and authentication flows.
- **Plugins**: packages that can contribute commands, skills, agents, hooks,
  MCP servers, output styles, and LSP configuration.

Build features decide whether some checked-in capabilities are live. Check
[`scripts/build.ts`](scripts/build.ts) and the corresponding runtime
`feature(...)` call sites rather than assuming a module is enabled because it
exists in the tree.

## Run from source

Cat Code has no supported end-user installer or update channel. Use a trusted
checkout with Git and Bun 1.4 or newer:

```sh
cd /path/to/cat-code && bun install
cd /path/to/cat-code && bun run build:dev:full
cd /path/to/cat-code && ./cli-dev
```

`bun run build:dev:full` is the terminal-engine build gate. It validates the
workspace maps, checks undefined names and changed TypeScript, builds the
development feature set, and confirms the resulting `cli-dev` binary runs.

For an unbundled source run:

```sh
cd /path/to/cat-code && bun run dev
```

The source-run path and `cli-dev` can differ where behavior is build-gated.
Use `./cli-dev --bare` when you deliberately want a smaller environment with
less implicit startup behavior, including no normal instruction discovery,
auto-memory, hook loading, or marketplace-plugin synchronization.

## Authentication, local state, and instructions

Authentication and session state are local and sensitive:

- The default Cat Code home is `~/.cat-code`; set `CLAUDE_CONFIG_DIR` to use a
  different configuration home.
- User settings live in `~/.cat-code/settings.json`; project settings use
  `.cat-code/settings.json` and private project settings use
  `.cat-code/settings.local.json`.
- Session transcripts are JSONL files under
  `~/.cat-code/projects/<project>/<session>.jsonl`. Subagent records and
  session memory sit alongside their parent session data.
- Codex account profiles contain credentials under `~/codex-vault/accounts/`.
  Treat that directory, the general credential store, and all session
  transcripts as private local data.

On macOS, the general credential layer prefers Keychain and falls back to a
mode-`0600` local file. Other supported platforms currently use the local
credential-file implementation. Do not commit credentials, vault files,
transcripts, or private local settings.

Instructions are layered. The current project-facing locations are `CLAUDE.md`,
`.cat-code/CLAUDE.md`, `.cat-code/rules/*.md`, and `CLAUDE.local.md`; selected
`.claude` paths remain compatibility inputs. New Cat Code project
configuration should prefer `.cat-code`.

## Desktop developer preview

The Electron application in [`app/`](app/) runs real engine-backed sessions
from source. It includes session management, transcript projection, permissions,
settings and account surfaces, worker views, history restore, and desktop peer
sessions.

Its runtime boundary is deliberate:

```text
React/Vite renderer
  -> default-deny preload
  -> Electron main and host registry
  -> Electron-free supervisor
  -> one Bun engine sidecar per live desktop session
  -> raw session events back to the renderer
```

The supervisor communicates with sidecars over Unix-domain sockets. The
sidecar is the final inbound validation boundary: it accepts a closed message
vocabulary, validates request shape and limits, reattaches engine-minted
permission data, and secret-screens outbound session events.

Run the preview from source:

```sh
cd /path/to/cat-code && bun run --cwd app dev
```

Treat it as a developer preview, not a released desktop product. It is not a
supported public download, installer, updater, or distribution channel. Each
live desktop session has its own Bun engine process, so resource use scales
with the number of live sessions. Main and preload changes require a full
development-app relaunch; renderer edits hot-reload during a normal source
development run.

## Development and verification

The root engine and desktop app have separate verification batteries.

### Terminal engine (`src/`, `scripts/`)

```sh
cd /path/to/cat-code && bun run build:dev:full
cd /path/to/cat-code && bun test path/to/focused.test.ts
```

There is no root all-tests command. Root `bun run typecheck` has a known
historical error baseline and is not the engine gate.

### Desktop (`app/`)

```sh
cd /path/to/cat-code && bun test app/
cd /path/to/cat-code && bun run --cwd app typecheck
cd /path/to/cat-code && bun run --cwd app typecheck:sidecar
cd /path/to/cat-code && bun run --cwd app test:hardening
cd /path/to/cat-code && bun run --cwd app renderer:build
```

Run the battery for every area you change. The desktop hardening check is a
required security boundary check for changes under `app/`.

## Repository guide

| Document | Use it for |
| --- | --- |
| [`CLAUDE.md`](CLAUDE.md) | Repository rules, architecture constraints, and required verification. |
| [`AGENTS.md`](AGENTS.md) | Agent-facing repository instructions. |
| [`docs/maps/WORKSPACE_MAP.md`](docs/maps/WORKSPACE_MAP.md) | Entry point to current subsystem ownership maps. |
| [`docs/maps/codex-core.md`](docs/maps/codex-core.md) | Codex account-pool, request-routing, and transport behavior. |
| [`docs/maps/web-app-runtime.md`](docs/maps/web-app-runtime.md) | Desktop runtime, sidecar, renderer, and host boundaries. |
| [`docs/migration/STATUS.md`](docs/migration/STATUS.md) | Current desktop migration status. |

Maps route to ownership; current source is authoritative. Dated plans and
reports are historical unless their containing index says otherwise.

## Boundaries and provenance

Cat Code is private source software. It is not published as a general package,
and this repository does not provide a declared root license or redistribution
grant. Do not infer rights to redistribute it, its vendored material, or
upstream-derived components.

The codebase began as a Claude Code fork and contains components with their own
provenance and obligations. It is a local development runtime, not a hosted
service or a released desktop application.
