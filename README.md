# Cat Code

Cat Code is a terminal-first, persistent coding-agent runtime for interactive
work and automation. It combines multi-provider model access, code and shell
tools, permission controls, resumable sessions, delegated workers, MCP
integrations, skills, hooks, plugins, and project-scoped memory in one local
runtime.

The terminal engine is the primary product today. An Electron desktop client is
under active development, but it is not a publicly distributed application yet.
The longer-term direction is an always-on personal agent system; the current
repository should not be mistaken for a finished hosted service or packaged
desktop release.

> **Repository status:** Cat Code is private source software. It is not published
> to npm, has no supported Cat Code-owned installer or update channel, and does
> not currently include a root license file. Run it from a trusted source
> checkout and do not infer redistribution rights that are not stated here.

## What works today

### Terminal agent

- Interactive, full-screen terminal sessions.
- Headless execution with text, JSON, or streaming JSON output.
- Multi-turn tool use with concurrent read-only work and serialized mutations.
- Automatic and explicit context compaction for long-running conversations.
- Project-scoped transcripts that can be continued, resumed, searched, named,
  or forked.
- Configurable model, reasoning effort, tools, permissions, prompts, agents,
  MCP servers, settings sources, and working directories.
- Prompt history, image paste, transcript navigation, Vim mode, custom
  keybindings, background tasks, and model switching.

### Models and providers

Cat Code can run Claude models through:

- Anthropic first-party APIs or Claude subscription OAuth
- AWS Bedrock
- Google Vertex AI
- Microsoft Foundry

It can also run GPT-5.6 Sol, Terra, and Luna through a configured
ChatGPT/Codex subscription account. This path uses Cat Code's Codex OAuth and
account-pool integration; it is not generic OpenAI API-key support. A `gpt-*`
model name always routes that request through the OpenAI/Codex path.

### Tools and permissions

The built-in tool surface includes filesystem reads and edits, patching, shell
execution, globbing, content search, web fetch, optional web search, notebooks,
subagents, tasks, goals, skills, MCP resources, and build-gated integrations
such as LSP and browser tooling.

Actual tool exposure is narrower than the registry. Feature flags, environment
checks, session mode, tool configuration, sandbox rules, and permission policy
all participate. Permission decisions combine schema validation, hooks,
allow/ask/deny rules, path checks, sandbox checks, and interactive approval.

When the transcript classifier is compiled in and the selected model supports
it, sessions without an explicit default can start in classifier-assisted
`auto` mode unless it has been disabled or circuit-broken. Other common modes
support interactive approval, automatically accepting edits, plan-only work,
and non-interactive denial when approval would otherwise be required. Explicit
safety checks and denies remain meaningful even when a more permissive mode is
selected.

### Agents and Agent Mode

The `Agent` tool delegates bounded work to specialized workers. Workers can run
in the foreground or background, use their own model and tool policy, preserve
status beside the parent session, resume after stopping, and optionally isolate
implementation in a Git worktree.

Agent Mode turns the main session into a worker-first orchestrator:

```bash
cd /path/to/cat-code && ./cli-dev --agent-mode
```

It can also be toggled from an interactive session:

```text
/agent
```

Agent Mode does not impose a mandatory plan-approval-execute ceremony. The main
conversation remains responsible for assigning work, checking evidence,
course-correcting workers, and synthesizing results.

Agent Mode execution and worker state do not require the legacy coordinator
runtime. Some fresh-session mode metadata and automatic mode restoration still
sit behind the legacy `COORDINATOR_MODE` build gate, which is not part of
`build:dev:full`; after resuming a session, re-enter Agent Mode if the mode was
not restored.

### Sessions, instructions, and memory

Sessions are stored as project-scoped JSONL transcripts under `~/.cat-code` by
default. Accepted user input is persisted before the model response, so an
interrupted request remains resumable.

Cat Code loads layered instructions from managed policy, user configuration,
repository instructions, directory rules, and local private instructions.
`.cat-code` is the current project namespace, while selected `.claude` paths
remain supported for Claude Code compatibility.

Auto-memory is separate from transcript history. It stores durable user
preferences and non-derivable project context in a small `MEMORY.md` index with
linked topic files. Auto-memory is enabled by default in normal local sessions
and disabled in minimal bare mode.

### Extensibility

Cat Code can be extended with:

- **Skills:** reusable instruction workflows exposed as slash commands and,
  when permitted by metadata, model-invocable capabilities.
- **Custom agents:** prompts, tools, models, effort, permissions, hooks, MCP
  requirements, turn limits, isolation, and scoped memory.
- **Hooks:** user-defined commands around session and tool lifecycle events.
- **MCP:** external tools and resources, discovered on demand where possible.
- **Plugins:** packages of commands, skills, agents, hooks, MCP servers, output
  styles, and LSP servers.

Availability can vary by build feature set, provider, authentication state, and
local configuration.

## Run from source

Cat Code does not currently have a supported end-user installation path. For an
existing source checkout, use Bun 1.4.0 or newer and Git:

```bash
cd /path/to/cat-code && bun install
cd /path/to/cat-code && bun run build:dev:full
cd /path/to/cat-code && ./cli-dev
```

`build:dev:full` is the repository's terminal-engine gate. It validates workspace
maps, parses changed TypeScript through the branch-diff lint step, builds
`./cli-dev` with the explicit development feature set from `scripts/build.ts`,
and verifies that the resulting binary prints its version.

For a faster unbundled source run:

```bash
cd /path/to/cat-code && bun run dev
```

This executes the TypeScript entry point directly. It does not compile the
`dev-full` feature set, so build-gated behavior can differ from `./cli-dev`.

Useful terminal examples:

```bash
cd /path/to/cat-code && ./cli-dev
cd /path/to/cat-code && ./cli-dev -p "Summarize this repository"
cd /path/to/cat-code && ./cli-dev -p --output-format json "List the current risks"
cd /path/to/cat-code && ./cli-dev -p --verbose --output-format stream-json "Review this branch"
cd /path/to/cat-code && ./cli-dev --continue
cd /path/to/cat-code && ./cli-dev --resume
```

Use `--bare` for a deliberately smaller execution environment:

```bash
cd /path/to/cat-code && ./cli-dev --bare -p "Inspect only the context I supplied"
```

Bare mode skips normal instruction discovery, hooks, LSP, plugin synchronization,
auto-memory, keychain reads, background prefetches, and most implicit skill
discovery. Explicit prompts, directories, MCP configuration, settings, agents,
and plugin directories can still be supplied by flags.

## Authentication

The two built-in OAuth entry points serve different account systems:

| Action | Purpose |
|---|---|
| `./cli-dev auth login` | Anthropic login: Claude subscription OAuth or Console/API billing. |
| `/login` inside an interactive session | OpenAI/Codex subscription login. |
| `./cli-dev codex status --json` | Inspect the configured Codex account pool. |

Anthropic also supports `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, provider
credential helpers, and provider-specific platform credentials. Bedrock,
Vertex, and Foundry use their own authentication mechanisms.

On macOS, the general secure-storage layer prefers Keychain and falls back to a
mode-`0600` plaintext file. Non-macOS platforms currently use that plaintext
layer rather than a completed libsecret integration. Independently, the Claude
and Codex account pools persist token-bearing account JSON under
`~/claude-vault` and `~/codex-vault`; those directories are not relocated by
`CLAUDE_CONFIG_DIR`.

`WebSearch` uses Exa and requires `EXA_API_KEY`. Without it the tool is not
offered to the model at all; normal filesystem, shell, MCP, and `WebFetch`
capabilities remain available.

## Local state and configuration

`CLAUDE_CONFIG_DIR` overrides the default configuration home of `~/.cat-code`.
The principal paths are:

| Path | Purpose |
|---|---|
| `~/.cat-code/settings.json` | User settings. |
| `~/.cat-code/.cat-code.json` | Global configuration and startup preferences. |
| `~/.cat-code/projects/` | Project-keyed transcripts, subagent records, memory, and session state. |
| `~/.cat-code/agents/` | User-defined agents. |
| `~/.cat-code/skills/` | User-installed skills. |
| `~/claude-vault/accounts/` | Claude account-pool records, including OAuth tokens. |
| `~/codex-vault/accounts/` | Codex account-pool records, including OAuth tokens. |
| `.cat-code/settings.json` | Repository-shared project settings. |
| `.cat-code/settings.local.json` | Private project-local settings. |
| `CLAUDE.md` or `.cat-code/CLAUDE.md` | Repository instructions. |
| `CLAUDE.local.md` | Private repository instructions. |
| `.cat-code/rules/*.md` | Path-sensitive project rules. |

Normal setting precedence is user, project, local, command-line settings, then
managed policy. Legacy `.claude` instruction and rule paths are still read for
compatibility; new Cat Code-specific configuration should prefer `.cat-code`.

## Experimental clients

### Electron desktop developer preview

The Electron app is a substantial development preview with real engine-backed
sessions, split panes, transcript rendering, permissions, session restore,
accounts, settings, goals, tasks, and workspace controls.

Run it from source:

```bash
cd /path/to/cat-code && bun run --cwd app dev
```

Its process boundary is intentionally strict:

```text
React/Vite renderer
  -> sandboxed, default-deny preload
  -> Electron main and durable host registry
  -> Electron-free supervisor
  -> one Bun engine sidecar per live session
  -> raw AppSessionEvent frames back to the renderer
```

The sidecar is the final inbound trust boundary. It validates the closed message
vocabulary, session addresses, schemas, frame sizes, rates, permission request
identities, and workspace trust. Credentials stay on the engine side, and
outbound frames pass through secret scanning.

The desktop client is not yet packaged, signed, auto-updating, or release-tested.
Packaging work has not opened, graphical acceptance remains incomplete, and
resource use scales with the one-engine-process-per-live-session design. Treat
it as a developer preview, not an installable desktop release.

## Architecture

The terminal path is the authoritative engine:

```text
src/entrypoints/cli.tsx
  -> src/main.tsx
  -> src/screens/REPL.tsx
  -> src/QueryEngine.ts and src/query.ts
  -> src/services/api/
  -> selected provider
```

Supporting systems surround that loop:

| Area | Primary source |
|---|---|
| Built-in tools and exposure | `src/tools.ts`, `src/tools/` |
| Commands and skills | `src/commands.ts`, `src/commands/`, `src/skills/` |
| Agent Mode and workers | `src/agent-mode/`, `src/tools/AgentTool/`, `src/tasks/` |
| Provider routing | `src/utils/model/providers.ts`, `src/services/api/` |
| Settings and persistence | `src/utils/settings/`, `src/utils/config.ts`, `src/utils/sessionStorage.ts` |
| Memory | `src/memdir/`, `src/services/SessionMemory/` |
| Desktop runtime | `app/` |
| Build feature sets | `scripts/build.ts` |

Many source-level capabilities are build-gated. A feature is live only when its
name is compiled into the selected feature set and runtime code consumes it.
Treat `scripts/build.ts` and the corresponding `feature(...)` call sites as the
source of truth rather than assuming every checked-in module ships.

## Development and verification

The repository contains three separate build and test domains.

### Terminal engine (`src/`, `scripts/`)

```bash
cd /path/to/cat-code && bun run build:dev:full
cd /path/to/cat-code && bun test path/to/focused.test.ts
```

There is no root all-tests script. Root `bun run typecheck` is a known-red
historical baseline and is not the engine gate.

### Desktop (`app/`)

```bash
cd /path/to/cat-code && bun test app/
cd /path/to/cat-code && bun run --cwd app typecheck
cd /path/to/cat-code && bun run --cwd app typecheck:sidecar
cd /path/to/cat-code && bun run --cwd app test:hardening
cd /path/to/cat-code && bun run --cwd app renderer:build
```

## Important limitations

- **No supported distribution:** do not use `install.sh`, `cat-code install`, or
  `cat-code update` as Cat Code release mechanisms. Inherited paths still depend
  partly on upstream Claude Code artifact or package infrastructure.
- **No declared license:** the repository has no root `LICENSE`, `NOTICE`, or
  package license field. Private access does not grant redistribution rights.
- **Build-dependent behavior:** development builds enable a finite feature set,
  not every implementation present in the tree.
- **Incomplete naming migration:** `.cat-code` is preferred, but compatible
  `.claude` paths and upstream-facing names remain in selected surfaces.
- **Experimental desktop client:** Electron is a useful development surface, not
  a supported public application.
- **No generic OpenAI API-key route:** GPT models require the Codex OAuth account
  pool used by the ChatGPT/Codex subscription integration.
- **Local-first, not hosted:** remote-control and always-on deployment work is
  incomplete and should not be treated as a production service boundary.

## Repository guide

| Document | Purpose |
|---|---|
| `CLAUDE.md` | Authoritative contributor rules, architecture constraints, and verification batteries. |
| `AGENTS.md` | Agent-facing repository instructions. |
| `docs/maps/WORKSPACE_MAP.md` | Router to current subsystem ownership maps. |
| `docs/2026-04-30-docs-readme.md` | Canonical-versus-historical documentation index. |
| `docs/migration/STATUS.md` | Current Electron migration program state. |

Maps route to source; source remains authoritative. Dated plans and reports are
historical records unless their containing index explicitly says otherwise.

## Provenance

Cat Code is a private fork and reconstruction of Claude Code, adapted into a
personal agent runtime. Claude Code and its original source belong to
Anthropic. Additional checked-in components retain their own provenance and
license obligations. A complete Cat Code licensing and attribution package has
not yet been assembled.
