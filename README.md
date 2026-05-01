# Cat Code

Cat Code is a private fork of Claude Code that is being turned into a personal
agent runtime.

Today it is still primarily a terminal coding agent with fork-specific provider,
prompt, orchestration, memory, and configuration changes. The longer-term goal is
an always-on personal agent that can run on a server Mac, keep working while the
main Mac sleeps, and handle coding, research, automation, and task follow-up from
one local-first runtime.

This README is the private operator entrypoint. It should stay accurate and
practical rather than promotional.

## Current Reality

What works today:

- Interactive terminal sessions through the `cat-code` CLI.
- One-shot/headless runs with `-p` / `--print`.
- Multiple provider routes: Anthropic, OpenAI, AWS Bedrock, Google Vertex AI,
  and Foundry.
- Agent Mode source support: an orchestration-focused session type where the
  main thread delegates implementation and verification work to workers. It is
  exposed only in builds with the `COORDINATOR_MODE` feature.
- Local project instructions, settings, transcripts, session memory, skills,
  plugins, MCP, hooks, and remote-control surfaces inherited or adapted from the
  Claude Code codebase.
- A private dev build that enables the selected experimental feature bundle in
  `scripts/build.ts`.

What is still in progress:

- The full always-on server-Mac deployment.
- Durable autonomous task queues and monitoring.
- A mature persistent memory system beyond the current memory/session surfaces.
- The final project identity, naming, and user-facing copy cleanup.
- Complete removal or replacement of every upstream assumption. Some upstream
  compatibility, policy, remote settings, and feature-gating surfaces still
  exist. Verify behavior in source when it matters.

For the long-term plan, see `docs/vision/2026-04-30-GOAL_PLAN.md`.

## Requirements

- Bun `>=1.3.11`
- Git
- macOS or Linux
- Credentials for whichever provider route you use

## Quick Start

```bash
bun install
bun run build:dev:full
./cli-dev
```

`bun run build:dev:full` is the preferred private development build. It runs
lint for changed TypeScript files, builds `./cli-dev`, enables the current
dev-full feature bundle, and prints the resulting version.

Use the installed binary when available:

```bash
cat-code
```

Use one-shot mode for scripts and pipes:

```bash
cat-code -p "summarize this repository"
```

## Run Modes

### Normal Session

```bash
cat-code
```

Starts the normal interactive terminal UI.

### One-Shot Session

```bash
cat-code -p "what changed in this branch?"
```

Runs a non-interactive request and exits. Use `--output-format json` or
`--output-format stream-json` when integrating with other tools.

### Agent Mode

```bash
cat-code --agent-mode
```

Or from inside an interactive session:

```text
/agent
```

Agent Mode requires a build with the `COORDINATOR_MODE` feature. When available,
it keeps the normal chat surface but makes the main model act as an orchestrator.
It can delegate focused implementation work to coding workers, spawn read-only
verification workers, preserve run-critical state across compaction, and use
project role/context files when present.

See `docs/agent/2026-04-30-agent-mode-readme.md` for the operational manual.

### Bare Mode

```bash
cat-code --bare -p "answer with no project auto-discovery"
```

Bare mode skips hooks, LSP, plugin sync, auto-memory, keychain reads, and
`CLAUDE.md` auto-discovery. It is useful for minimal or tightly controlled
scripted runs.

## Providers

Provider selection is handled by environment variables, saved startup preference,
session/model selection, and provider-specific auth flows. The current routing
source of truth is `src/utils/model/providers.ts`.

### Anthropic

Anthropic is the default provider when no other provider route is selected.

```bash
cat-code --model claude-sonnet-4-6
```

### OpenAI

```bash
export CLAUDE_CODE_USE_OPENAI=1
cat-code
```

GPT-family model names also route requests through the OpenAI provider path.

```bash
cat-code --model gpt-5.4
```

### AWS Bedrock

```bash
export CLAUDE_CODE_USE_BEDROCK=1
export AWS_REGION="us-east-1"
cat-code
```

### Google Vertex AI

```bash
export CLAUDE_CODE_USE_VERTEX=1
cat-code
```

### Foundry

```bash
export CLAUDE_CODE_USE_FOUNDRY=1
export ANTHROPIC_FOUNDRY_API_KEY="..."
cat-code
```

## Authentication

Interactive login:

```text
/login
```

CLI auth login:

```bash
cat-code auth login
```

For Anthropic API-key use:

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
cat-code
```

Provider-specific routes use their own credentials in addition to the provider
selection variables above. Login is not just a token write: the post-login path
refreshes account state, remote managed settings, policy limits, feature gates,
trusted-device state, and session/cost state.

## Builds

The main build commands are documented in `CLAUDE.md`. In normal private
development, use:

```bash
bun run build:dev:full
./cli-dev
```

Other available build paths:

| Command | Output | Notes |
|---|---:|---|
| `bun run build` | `./cli` | Regular external binary. |
| `bun run build:dev` | `./cli-dev` | Dev-stamped binary without the full dev feature bundle. |
| `bun run build:dev:full` | `./cli-dev` | Preferred private build. Enables the dev-full bundle from `scripts/build.ts`. |
| `bun run compile` | `./dist/cli` | Alternative compiled output path. |

Feature flag audits can drift. Treat `scripts/build.ts` as the source of truth
for what the current dev-full build enables.

## Local State

Cat Code stores user-global state under `~/.cat-code` by default, unless
`CLAUDE_CONFIG_DIR` is set.

Important locations:

| Path | Purpose |
|---|---|
| `~/.cat-code/settings.json` | User settings. |
| `~/.cat-code/.cat-code.json` | Global config and provider/startup state. |
| `~/.cat-code/CLAUDE.md` | User-global instruction memory. |
| `~/.cat-code/projects/` | Session transcripts, session memory, and project-keyed state. |
| `~/.cat-code/agents/` | Personal custom agents. |
| `~/.cat-code/skills/` | User-installed skills. |

Project-shared state can live in the repository:

| Path | Purpose |
|---|---|
| `CLAUDE.md` | Project instructions and build guidance. |
| `.claude/settings.json` | Shared project settings. |
| `.claude/rules/*.md` | Shared project rules. |
| `.cat-code/roles/*.md` | Optional Agent Mode worker role notes. |
| `.cat-code/context/*.md` | Optional high-level Agent Mode context files listed to workers. |

Project-local/private state can live in:

| Path | Purpose |
|---|---|
| `CLAUDE.local.md` | Private project instructions. |
| `.claude/settings.local.json` | Private project settings. |

For the detailed config and persistence model, see
`docs/reference/2026-04-30-WORKSPACE_MAP.md`.

## Repository Map

Start here:

| Document | Use |
|---|---|
| `README.md` | Private operator overview. |
| `CLAUDE.md` | Build commands, high-level architecture, coding guidance. |
| `AGENTS.md` | Agent-facing repository instructions and routing rules. |
| `docs/reference/2026-04-30-WORKSPACE_MAP.md` | Routing map for source inspection. |
| `docs/prompts/2026-04-30-prompt-surfaces.md` | Prompt and instruction surface index. |
| `docs/agent/2026-04-30-agent-mode-readme.md` | Agent Mode manual. |
| `docs/vision/2026-04-30-GOAL_PLAN.md` | Long-term project vision and milestones. |

Important source surfaces:

| Area | Start |
|---|---|
| CLI startup | `src/entrypoints/cli.tsx`, `src/main.tsx` |
| Main interactive UI | `src/screens/REPL.tsx` |
| Commands | `src/commands.ts`, `src/commands/` |
| Tools | `src/tools.ts`, `src/tools/` |
| Model/provider routing | `src/utils/model/providers.ts`, `src/services/api/` |
| Prompt behavior | `src/constants/prompts.ts`, `src/utils/systemPrompt.ts` |
| Agent Mode | `src/agent-mode/`, `src/tools/AskOrchestratorTool/` |
| Settings/config | `src/utils/settings/`, `src/utils/config.ts` |
| Memory/session state | `src/memdir/`, `src/services/SessionMemory/`, `src/utils/sessionStorage.ts` |
| Build system | `scripts/build.ts` |

Use `docs/reference/2026-04-30-WORKSPACE_MAP.md` before broad source search for any
non-trivial bug, question, or feature work.

## Reality Checks

- This is a forked source snapshot, not a clean upstream workspace.
- README claims are not the source of truth for runtime behavior. Source files
  and routing docs win.
- Analytics and telemetry paths are fork-modified, but not every service under
  `src/services/analytics/` is irrelevant; some feature/config plumbing still
  matters.
- Policy limits, remote managed settings, feature gates, and org/account checks
  still exist in the codebase. Do not assume they are gone without checking the
  relevant source.
- Some docs describe plans or older designs. Prefer implementation when docs and
  source disagree.

## Known Stale Surfaces

- `install.sh` still carries old `free-code` naming, clone paths, symlinks, and
  output text. Do not use it as the current installation source of truth until
  it is updated or removed.

## Provenance

The original Claude Code source belongs to Anthropic. This private fork exists
as a local reconstruction and adaptation of that codebase for personal use. Use,
modify, and distribute with that provenance in mind.
