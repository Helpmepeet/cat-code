# Build, Release, And Testing Routing Map

Last refreshed: 2026-08-28 against `CLAUDE.md`,
`docs/maps/WORKSPACE_MAP.md`, `package.json`, `scripts/build.ts`,
`scripts/test-codex-*.ts`,
`scripts/typecheck/renderer-engine-types/`, `renderer-theme/`,
`app/package.json`, `app/scripts/`, `src/migrations/`,
update/release/upgrade command surfaces, and colocated tests.

Use this as the daily-refreshable routing layer for build, development,
compile, release-note, updater, migration, validation, lint, and test-routing
work. It is not the source of truth for exact behavior; use it to choose owner
files, then verify current source before changing code.

## Refresh Checklist

- Read `CLAUDE.md` and `docs/maps/WORKSPACE_MAP.md` first.
- Re-open `package.json` scripts before advising commands; this repo has no
  package-level `test` script.
- Check `scripts/build.ts` before changing feature gates, version macros,
  output paths, or bundled externals.
- Check `src/main.tsx` before changing startup migrations or the shell
  `cat-code update` / `claude update` command path.
- Check `src/cli/update.ts`, `src/utils/autoUpdater.ts`, and
  `src/components/AutoUpdaterWrapper.tsx` before changing update behavior.
- Check `src/utils/releaseNotes.ts` and `src/commands/release-notes/` before
  changing release-note display or changelog caching.
- Check colocated `*.test.ts` / `*.test.tsx` files near the behavior under
  change, then run focused `bun test <paths>`.
- For docs-only changes, use `git diff --check` and path/link sanity checks
  instead of a full build unless code behavior changed.

## Command Routing

| Need | Start here | Then inspect | Current route |
|---|---|---|---|
| Canonical local verification build | `CLAUDE.md` | `package.json`, `scripts/build.ts` | Use `bun run build:dev:full`. It runs lint, builds `./cli-dev` with `--dev --feature-set=dev-full`, then runs `./cli-dev --version`. |
| Plain build script behavior | `scripts/build.ts` | `src/entrypoints/cli.tsx`, runtime `feature(...)` call sites | `bun run build` is defined but root instructions say not to use it unless explicitly asked. It emits `./cli`. |
| Development build | `scripts/build.ts` | `package.json` | `bun run build:dev` emits `./cli-dev`, sets development macros, experimental-build env, dev semver suffix, and git-log changelog macro. |
| Compile output | `scripts/build.ts` | `package.json` | `bun run compile` passes `--compile` and emits `./dist/cli`. The build script also supports `--compile --dev` internally, which would emit `./dist/cli-dev`, but no package script exposes that combo. |
| Source dev entrypoint | `package.json` | `src/entrypoints/cli.tsx`, `src/main.tsx` | `bun run dev` runs the TSX entrypoint directly. Prefer it only when debugging source startup; build verification remains `build:dev:full`. |
| Portable desktop renderer theme check | `renderer-theme/README.md` | `renderer-theme/theme.css`, `renderer-theme/package.json`, `renderer-theme/vite.config.ts` | This is a temporary Tailwind v4 build harness for design-token handoff, not the final renderer scaffold. Run `bun run build` from `renderer-theme/`. |
| Renderer-to-engine type adoption check | `scripts/typecheck/renderer-engine-types/README.md` | `scripts/typecheck/renderer-engine-types/tsconfig.json`, snapshot declarations, `fixture.ts` | This portable type-only fixture currently uses cited snapshots because direct aliases pull in the engine runtime graph. Re-sync snapshots from their canonical source types before renderer adoption, then run the documented isolated `tsc` command. |
| Electron desktop development | `app/package.json` | `app/scripts/dev.ts`, `app/main/main.ts`, `app/main/mainDecisions.ts`, `app/renderer/vite.config.ts` | `bun run --cwd app dev` builds Electron sources, starts the renderer dev server, and launches the desktop shell. The Bun engine runs in a separate sidecar process; `SIDECAR_RUNTIME_ARGS` enables the classifier and reactive-compaction runtime features. |
| Electron desktop verification | `app/package.json` | `app/tsconfig.json`, `app/scripts/sidecar-typecheck.ts`, `app/scripts/run-hardening-smoke.ts` | Run desktop tests, both typecheck boundaries, the renderer build, and the hardening smoke independently; the root lint configuration does not yet cover `app/**`. The sidecar wrapper reports owned `app/sidecar/` and `app/shared/` diagnostics while tolerating known upstream engine diagnostics. |
| Electron desktop packaging | `app/scripts/package-app.ts` | `app/package.json`, `app/main/mainDecisions.ts`, `app/sidecar/packagedEntry.ts`, `docs/migration/decisions/LOCAL-USE-CONTRACT.md` | `bun run --cwd app package` builds the macOS `.app` into its generated output directory, wiping that directory first. It compiles the sidecar and its engine graph into one standalone Bun executable with the same features `SIDECAR_RUNTIME_ARGS` passes in development, stamps `CATCODE_BUILD_ID`/`CATCODE_COMMIT_ID` as build-time constants, sets `com.catcode.desktop`, and ad-hoc signs the nested binary before the bundle. No packaging dependency is involved. |
| Packaged bundle stowaway scan | `app/scripts/packagedBundleScan.ts` | `app/scripts/package-app.ts`, `app/scripts/packagedBundleScan.test.ts` | Path and content rules that fail the packaging build when a credential, key material, test source, source map, `node_modules` tree, or the development preload appears in the bundle. There is deliberately no artifact manifest; the local-use contract rules one out. |
| Packaged launch verification | `app/scripts/packaged-launch-smoke.ts` | `app/scripts/package-app.ts`, `app/main/main.ts` | `bun run --cwd app smoke:packaged` proves the generated artifact is self-contained: the compiled sidecar runs with no `bun` on `PATH` and a working directory outside the checkout, and the launched app takes the packaged branch while a development renderer URL is set. Electron ignores `--require` in a packaged app, so it asserts on production main's own stdout rather than an injected harness. |
| Shell update command | `src/main.tsx` | `src/entrypoints/cli.tsx`, `src/cli/update.ts` | `program.command('update').alias('upgrade')` delegates to `src/cli/update.ts`. Early CLI rewrites `--update` and `--upgrade` to the `update` subcommand. |
| Slash subscription upgrade | `src/commands/upgrade/index.ts` | `src/commands/upgrade/upgrade.tsx`, `src/commands/rate-limit-options/` | `/upgrade` opens the Max upgrade URL and starts login refresh. This is not the binary updater. |
| Release notes command | `src/commands/release-notes/index.ts` | `src/commands/release-notes/release-notes.ts`, `src/utils/releaseNotes.ts` | `/release-notes` fetches changelog with a short timeout, falls back to cached notes, and prints recent or latest notes. |
| Codex account status subcommand | `src/main.tsx`, `src/cli/handlers/codexStatus.ts` | `src/services/api/codexStatus.ts`, `src/services/api/codexStatus.test.ts` | `cat-code codex status --json` emits a read-only advisory JSON observation. It is a CLI/status surface, not a build gate or account reservation mechanism. |

## Build Script Details

`scripts/build.ts` owns build-time macros, output path selection, feature
arguments, bundled externals, and executable chmod.

| Concern | Owner | Notes |
|---|---|---|
| Output path | `scripts/build.ts` | Default `./cli`; `--dev` gives `./cli-dev`; `--compile` gives `./dist/cli`; `--compile --dev` gives `./dist/cli-dev`. |
| Version macro | `scripts/build.ts` | Normal builds use `package.json` version. Dev builds append `-dev.<yyyymmdd>.t<hhmmss>.sha<gitsha>`. |
| Changelog macro | `scripts/build.ts` | Dev builds use last 20 git commits. Normal builds set a GitHub URL string. |
| Bundler command | `scripts/build.ts` | Uses `bun build ./src/entrypoints/cli.tsx --compile --target bun --format esm --minify --bytecode --packages bundle --conditions bun`. |
| External native packages | `scripts/build.ts` | External patterns include `@ant/*`, `audio-capture-napi`, `image-processor-napi`, `modifiers-napi`, and `url-handler-napi`. |
| Defines | `scripts/build.ts` | Defines USER_TYPE as external, logo, plan verification false, CCR bundle, version/build/package macros, feedback channel, issues explainer, and changelog. |

## Feature Sets

Default build features are `AUTO_MODE_UPSTREAM_PORT`, `TRANSCRIPT_CLASSIFIER`,
and `VOICE_MODE`.

`--feature <name>` and `--feature=<name>` add a single feature. `--feature-set
dev-full` or `--feature-set=dev-full` adds the current experimental set from
`scripts/build.ts`:

```text
AGENT_MEMORY_SNAPSHOT, AGENT_TRIGGERS, AGENT_TRIGGERS_REMOTE, AWAY_SUMMARY,
BASH_CLASSIFIER, BRIDGE_MODE, BUILTIN_EXPLORE_PLAN_AGENTS, CACHED_MICROCOMPACT,
CCR_AUTO_CONNECT, CCR_MIRROR, CCR_REMOTE_SETUP, COMPACTION_REMINDERS,
CONNECTOR_TEXT, EXTRACT_MEMORIES, HISTORY_PICKER, HOOK_PROMPTS, KAIROS_BRIEF,
KAIROS_CHANNELS, LODESTONE, MCP_RICH_OUTPUT, MESSAGE_ACTIONS,
NATIVE_CLIPBOARD_IMAGE, NEW_INIT, POWERSHELL_AUTO_MODE,
PROMPT_CACHE_BREAK_DETECTION, QUICK_SEARCH, SHOT_STATS, TEAMMEM, TOKEN_BUDGET,
TREE_SITTER_BASH, TREE_SITTER_BASH_SHADOW, ULTRAPLAN, ULTRATHINK,
UNATTENDED_RETRY, VOICE_MODE
```

Feature changes need both sides checked: the build-time list in
`scripts/build.ts` and runtime `feature(...)` call sites in entrypoints,
commands, tools, tasks, and components.

## Migration Routing

Startup migrations are owned by `src/migrations/runEngineMigrations.ts` under
`CURRENT_MIGRATION_VERSION`. The current version is `15`. Shared `init()` calls
this owner after enabling configs, so terminal and desktop-first launches use
the same cross-process-locked sequence.

| Migration area | Owner file | Routing notes |
|---|---|---|
| Migration order and version gate | `src/migrations/runEngineMigrations.ts` | Fresh-reads the global migration version under one config-home lock, runs versioned migrations, persists the version only after success, and awaits the separately retryable changelog migration. |
| Auto-updates config to settings env | `src/migrations/migrateAutoUpdatesToSettings.ts` | Moves explicit user-disabled auto-updates to user settings `env.DISABLE_AUTOUPDATER = "1"` unless native protection set the old flag. |
| Bypass-permission prompt acceptance | `src/migrations/migrateBypassPermissionsAcceptedToSettings.ts` | Moves global config `bypassPermissionsModeAccepted` to user settings `skipDangerousModePermissionPrompt`. |
| Project MCP approval fields | `src/migrations/migrateEnableAllProjectMcpServersToSettings.ts` | Moves old project config MCP approval fields into local settings and removes old project config keys. |
| Pro/default model notification | `src/migrations/resetProToOpusDefault.ts` | First-party Pro-only migration, records completion and optional notification timestamp. |
| Sonnet 1M pin preservation | `src/migrations/migrateSonnet1mToSonnet45.ts` | One-time global-config completion flag, preserves old `sonnet[1m]` intent by pinning explicit Sonnet 4.5 1M. |
| Legacy Opus cleanup | `src/migrations/migrateLegacyOpusToCurrent.ts` | First-party legacy Opus explicit strings move to `opus`, with timestamp notification. |
| Sonnet 4.5 to 4.6 alias | `src/migrations/migrateSonnet45ToSonnet46.ts` | First-party Pro/Max/Team Premium user settings only; project/local pins are left alone. |
| Opus to Opus 1M merge | `src/migrations/migrateOpusToOpus1m.ts` | Eligible merged-Opus users with user settings `model: "opus"` move to `opus[1m]` or default unset. |
| Bridge config rename | `src/migrations/migrateReplBridgeEnabledToRemoteControlAtStartup.ts` | Copies old global `replBridgeEnabled` to `remoteControlAtStartup` only when new key is unset. |
| Auto-mode prompt reset | `src/migrations/resetAutoModeOptInForDefaultOffer.ts` | Feature-gated by `TRANSCRIPT_CLASSIFIER`; clears old skip prompt only for enabled auto-mode users not defaulting to auto. |
| Upstream/fork data copy | `src/migrations/migrateFromUpstreamClaude.ts` | Shared `init()` awaits this copy-only migration before enabling configs. Its destination check and copy run under a lock beside the destination directory. |

## Release Notes

| Concern | Owner | Notes |
|---|---|---|
| Changelog URL and cache | `src/utils/releaseNotes.ts` | Fetches upstream raw changelog and caches at `getClaudeConfigHomeDir()/cache/changelog.md`. Code comments may still say `~/.claude`; the function uses Cat Code config home. |
| Cache migration | `src/utils/releaseNotes.ts` | `migrateChangelogFromConfig()` moves deprecated global-config cached changelog into the cache file and removes the old field. |
| Startup prefetch | `src/setup.ts` | Non-bare startup awaits `checkForReleaseNotes()` and preloads recent activity only when notes exist. This is after the early `tengu_started` beacon. |
| Slash command output | `src/commands/release-notes/release-notes.ts` | Fetch attempt is capped by a 500ms timeout, then cached notes are used. Recent notes are based on `lastReleaseNotesSeen`, current `MACRO.VERSION`, and at most three versions for the command. |
| Ant/dev macro path | `src/utils/releaseNotes.ts`, `scripts/build.ts` | When `USER_TYPE` is `ant`, release notes come from `MACRO.VERSION_CHANGELOG`; dev builds fill that macro from recent git log. |

There is no top-level `release/` directory in the current workspace. Route
release-note behavior through `src/utils/releaseNotes.ts` and
`src/commands/release-notes/`.

## Update And Upgrade

| Concern | Owner | Notes |
|---|---|---|
| CLI argument rewrite | `src/entrypoints/cli.tsx` | A lone `--update` or `--upgrade` is rewritten to `update` before loading the full CLI. |
| Update subcommand registration | `src/main.tsx` | `update` has alias `upgrade` and imports `src/cli/update.ts`. This is binary/package update, not subscription upgrade. |
| Update command implementation | `src/cli/update.ts` | Prints current version, runs diagnostics, warns about multiple installs/config mismatch, handles development/package-manager/native/npm-local/npm-global paths, and regenerates completions after success. |
| Shared updater utilities | `src/utils/autoUpdater.ts` | Owns min-version assertion, max-version kill switch, npm/GCS latest lookup, minimum-version skip, lock file, permission check, and global npm install. |
| Runtime updater selection | `src/components/AutoUpdaterWrapper.tsx` | Chooses package-manager, native, or JS/npm updater based on `getCurrentInstallationType()`. |
| JS/npm interactive updater | `src/components/AutoUpdater.tsx` | Skips test/dev, checks every 30 minutes, caps to max version, skips development builds, updates npm-local or npm-global based on actual installation. |
| Native interactive updater | `src/components/NativeAutoUpdater.tsx` | Uses native installer update path and handles lock contention, success, up-to-date, and failure display. |
| Package-manager updater notice | `src/components/PackageManagerAutoUpdater.tsx` | Does not install. Shows command hints for Homebrew, winget, apk, or generic package-manager update. |
| Auto-updater disable reason | `src/utils/config.ts` | Disabled by development `NODE_ENV`, `DISABLE_AUTOUPDATER`, essential-traffic-only env reason, or old config `autoUpdates === false` unless native protection applies. |
| Slash `/upgrade` | `src/commands/upgrade/upgrade.tsx` | Opens `https://claude.ai/upgrade/max`, blocks highest Max users, and invokes login. Availability is `claude-ai`, not enterprise, and not `DISABLE_UPGRADE_COMMAND`. |

## Tests And Validation

| Validation | Command | Owner |
|---|---|---|
| Full repo build gate requested by root docs | `bun run build:dev:full` | `CLAUDE.md`, `package.json`, `scripts/build.ts` |
| Docs-only whitespace/path sanity | `git diff --check` | Git diff |
| Focused unit tests | `bun test <test-paths>` | Colocated `*.test.ts` / `*.test.tsx` |
| Portable renderer theme | `cd renderer-theme && bun run build` | `renderer-theme/package.json`, Vite |
| Renderer engine-type fixture | `bunx tsc --project scripts/typecheck/renderer-engine-types/tsconfig.json --noEmit` | Isolated renderer type-adoption config |
| Electron desktop tests | `bun test app/` | Desktop unit, boundary, and round-trip tests |
| Electron desktop typechecks | `bun run --cwd app typecheck && bun run --cwd app typecheck:sidecar` | Snapshot-isolated shell graph plus scoped real engine-sidecar diagnostics |
| Electron desktop renderer | `bun run --cwd app renderer:build` | Vite renderer bundle |
| Electron hardening smoke | `bun run --cwd app test:hardening` | Packaged Electron security-baseline checks |
| Codex standalone smoke | `bun run scripts/test-codex-core.ts --account <alias> --model <model> --prompt "hello"` | `scripts/test-codex-core.ts` |
| Codex two-turn smoke | `bun run scripts/test-codex-core-conversation.ts --account <alias> --model <model>` | `scripts/test-codex-core-conversation.ts` |
| Codex effort mapping | `bun run scripts/test-codex-effort.ts` | `scripts/test-codex-effort.ts` |
| Codex tool-call continuity | `bun run scripts/test-codex-stream-tool-call-ids.ts` | `scripts/test-codex-stream-tool-call-ids.ts` |
| Codex status JSON | `bun test src/services/api/codexStatus.test.ts` | `src/services/api/codexStatus.ts` |

`scripts/test-codex-core-conversation.ts` has a usage string mentioning
`pnpm tsx`, but the file is runnable through the repo's Bun workflow when Bun
can execute the TS entrypoint.

## Test Routing

There is no package-level `test` script. Use `bun test` directly with focused
paths.

| Change area | First tests |
|---|---|
| Codex adapter/request/stream behavior | `bun test src/services/api/codex-fetch-adapter.test.ts src/services/api/codex-websocket-transport.test.ts src/services/api/codex-continuation-e2e.test.ts` |
| Codex account pool, lease, refresh, usage | `bun test src/services/api/codexAccountPool.test.ts src/services/api/codexAccountLeaseManager.test.ts src/services/api/codexTokenRefresh.test.ts src/services/api/codexUsage.test.ts` |
| Minimal Codex core | `bun test src/codex-core/request.test.ts` plus the `scripts/test-codex-*.ts` smoke scripts when real account access is relevant. |
| Agent Mode behavior | `bun test src/agent-mode/*.test.ts src/agent-mode/*.test.tsx src/tools/AgentTool/*.test.ts` with narrower paths preferred for small changes. |
| Tasks and workers | `bun test src/tasks/LocalAgentTask/LocalAgentTask.test.ts src/tasks/RemoteAgentTask/RemoteAgentTask.test.ts` |
| Compact/context behavior | `bun test src/services/compact/*.test.ts` |
| App runtime | `bun test src/app-runtime/*.test.ts` |
| P5-5c cross-process contention probes | `src/utils/atomicFile.probe.test.ts`, `src/utils/transcriptLease.probe.test.ts`, `src/migrations/runEngineMigrations.probe.test.ts`, `src/codex-core/accountRefreshContention.probe.test.ts`, `src/utils/secureStorage/crossProcessStorage.probe.test.ts`, `src/services/autoDream/consolidationLock.probe.test.ts`, `src/services/teamMemorySync/teamMemorySync.probe.test.ts` | Run `bun test src/utils/atomicFile.probe.test.ts src/utils/transcriptLease.probe.test.ts src/migrations/runEngineMigrations.probe.test.ts src/codex-core/accountRefreshContention.probe.test.ts src/utils/secureStorage/crossProcessStorage.probe.test.ts src/services/autoDream/consolidationLock.probe.test.ts src/services/teamMemorySync/teamMemorySync.probe.test.ts` with synthetic isolated files and no live account/network access. |
| Commands | Run the specific command test, for example `bun test src/commands/goal/goal.test.ts src/commands/agent/agent.test.ts`. |
| Components/helpers | Use colocated tests such as `src/components/ConsoleOAuthFlow.test.ts` or `src/tools/*/*.test.tsx`. |

Colocated tests use `bun:test` imports (`describe`, `test`, `expect`,
`afterEach`) and often expose `_forTest` helpers or reset functions from the
module under test. Prefer those local reset helpers over broad process-state
workarounds.

## Lint Behavior

`bun run lint` runs ESLint only on changed TypeScript files from
`git diff --name-only main...HEAD`, and only if those paths still exist. The
root lint uses `eslint-suppressions.json` plus suppressions for:

- `react-hooks/rules-of-hooks`
- `react-hooks/exhaustive-deps`
- `custom-rules/prefer-use-terminal-size`

This means lint is branch-diff scoped, not a full-repo lint. If a change depends
on generated files, renamed files, or files outside `main...HEAD`, verify the
actual command expansion before trusting a clean lint result.

## Traps And Stale Assumptions

- `bun run build` and `./cli` are defined, but `CLAUDE.md` says not to use them
  unless explicitly asked. Default to `bun run build:dev:full` for build
  verification.
- `/upgrade` and `cat-code update` are different systems. `/upgrade` is a
  subscription/login command; `update`/`upgrade` in `src/main.tsx` updates the
  installed binary/package.
- `--update` and `--upgrade` are not commander flags. `src/entrypoints/cli.tsx`
  rewrites those single-argument mistakes to the `update` subcommand.
- Package-manager installs are not auto-installed by Cat Code. The UI and CLI
  print package-manager commands instead.
- Auto-updates skip test and development environments. A dev build failing to
  auto-update is expected.
- Max-version and minimum-version settings can make an apparent newer version
  intentionally skipped or capped.
- The updater runs npm/bun registry commands from the home directory to avoid
  project-level `.npmrc` or `.bunfig.toml` influence. Preserve that when
  editing update code.
- The auto-updater lock lives under the Cat Code config home as `.update.lock`.
  Lock contention can be a normal in-progress update, not a broken install.
- Migration files are mostly idempotent and often intentionally read/write only
  `userSettings`. Do not switch them to merged settings unless you want to
  promote project/local/policy values globally.
- Adding a migration file is not enough. It must be imported, ordered in
  `runEngineMigrations.ts`, and the migration version must be bumped when existing
  users need it.
- Release-note code still references upstream Claude changelog URLs. Verify
  source before assuming Cat Code has a separate release directory or bundled
  changelog file.
- `bun run lint` can miss unchanged files affected by API changes. Run focused
  tests and, for shared type changes, broaden lint/test selection manually.
- Some checked-in TSX files include React compiler artifacts or source maps.
  Avoid formatting or rewriting unrelated generated-looking regions while doing
  scoped fixes.
