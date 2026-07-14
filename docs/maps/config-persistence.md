# Config And Persistence Routing Map

Last refreshed: 2026-07-13

## Purpose

Use this map to route work involving settings, config files, environment
application, managed policy, transcripts, session restore, memory, and recovery.
It is a navigation aid, not the source of truth. Verify behavior in source
before changing persistence or precedence rules.

Start with `docs/maps/WORKSPACE_MAP.md` for broad routing, then use this file
for the config and persistence slice.

## First Files To Inspect

| Need | Inspect first | Then inspect |
|---|---|---|
| Broad routing fallback | `docs/maps/WORKSPACE_MAP.md` | Relevant focused sub-map under `docs/maps/` |
| Settings merge behavior | `src/utils/settings/settings.ts` | `src/utils/settings/constants.ts`, `src/utils/settings/settingsCache.ts` |
| Global config and project-keyed user state | `src/utils/config.ts` | `src/utils/env.ts`, `src/utils/envUtils.ts` |
| Environment application from config/settings | `src/utils/managedEnv.ts` | `src/utils/managedEnvConstants.ts`, `src/utils/sessionEnvVars.ts` |
| Instruction memory and rule discovery | `src/utils/claudemd.ts` | `src/utils/config.ts`, `src/utils/settings/constants.ts` |
| Transcript persistence and resume | `src/utils/sessionStorage.ts` | `src/utils/conversationRecovery.ts`, `src/utils/sessionRestore.ts` (includes subagent metadata under `<session>/subagents/` such as `agentName`) |
| Deferred continuation queue | `src/services/deferredContinuation.ts` | `src/services/deferredContinuationRunner.ts`, `src/types/logs.ts`, and `src/utils/sessionStorage.ts`; user-private, fsync-backed queue/history/locks live under `${CLAUDE_CONFIG_DIR:-~/.cat-code}/deferred-continuations/`. Jobs never persist prompts, credentials, account identity, transcript paths, or temporary permission grants. |
| Persistent memory | `src/memdir/paths.ts`, `src/memdir/memdir.ts` | `src/memdir/teamMemPaths.ts`, `src/utils/permissions/filesystem.ts` |
| Session memory summaries | `src/services/SessionMemory/sessionMemory.ts` | `src/services/SessionMemory/sessionMemoryUtils.ts`, `src/utils/permissions/filesystem.ts` |
| Admin/remote policy | `src/services/remoteManagedSettings/index.ts`, `src/services/policyLimits/index.ts` | `src/utils/settings/mdm/`, `src/utils/settings/managedPath.ts` |

## Routing Table

| If you want to change or verify X | Inspect first | Then inspect | Notes |
|---|---|---|---|
| Normal settings precedence | `src/utils/settings/settings.ts` | `src/utils/settings/constants.ts`, `src/utils/settings/settingsCache.ts` | `loadSettingsFromDisk()` starts with plugin settings, then enabled sources in `SETTING_SOURCES` order. `flagSettings` and `policySettings` are always included by `getEnabledSettingSources()`. |
| Which settings files exist | `src/utils/settings/settings.ts` | `src/utils/envUtils.ts`, `src/utils/settings/managedPath.ts` | User settings are under `getClaudeConfigHomeDir()` as `settings.json` or `cowork_settings.json`; project settings are `.cat-code/settings.json`; local settings are `.cat-code/settings.local.json`. |
| `--setting-sources` behavior | `src/utils/settings/constants.ts` | `src/bootstrap/state.ts`, `src/main.tsx` | The flag can narrow user/project/local loading. It does not exclude `flagSettings` or `policySettings`. |
| Inline or file-backed flag settings | `src/utils/settings/settings.ts` | `src/bootstrap/state.ts` | `flagSettings` can come from a `--settings` path and inline SDK settings. Inline settings merge on top of the flag file. |
| Editable settings writes | `src/utils/settings/settings.ts` | `src/utils/settings/internalWrites.ts`, `src/utils/settings/changeDetector.ts` | `updateSettingsForSource()` writes only user/project/local sources. Arrays replace during source writes but concat/dedupe during normal merged reads. |
| Hot reload of settings | `src/utils/settings/changeDetector.ts` | `src/utils/settings/applySettingsChange.ts`, `src/utils/hooks.ts` | File watcher changes run `ConfigChange` hooks first. `fanOut()` owns cache reset before subscribers read fresh settings, and `applySettingsChange()` is shared by both interactive AppState updates and the headless/SDK subscribe path. MDM/plist/registry changes are polled. |
| Initial merged settings snapshot | `src/utils/settings/settings.ts` | `src/utils/settings/settingsCache.ts` | `getInitialSettings()`/`getSettings_DEPRECATED()` use a session cache. Reset that cache through the established change paths, not per listener. |
| Session-only fast mode state | `src/utils/fastMode.ts` | `src/commands/fast/fast.tsx`, `src/components/Settings/Config.tsx`, `src/state/AppState.tsx` | Fast mode availability and cooldown live in runtime/AppState. `/fast` and the Settings Config toggle update the current session and model, not `userSettings.fastMode`; startup defaults to off after availability/model checks. |
| Global config file location | `src/utils/env.ts` | `src/utils/envUtils.ts`, `src/constants/oauth.ts` | `getGlobalClaudeFile()` uses legacy `~/.cat-code/.config.json` if present, otherwise `${CLAUDE_CONFIG_DIR:-~/.cat-code}/.cat-code*.json`. The suffix can vary for OAuth config. |
| Global config reads and writes | `src/utils/config.ts` | `src/utils/env.ts`, `src/utils/lockfile.ts` | `enableConfigs()` gates reads. `saveGlobalConfig()` uses a lock, backups, cache write-through, and an auth-loss guard. |
| Project instruction files and rule globs | `src/utils/claudemd.ts` | `src/utils/config.ts`, `src/utils/markdownConfigLoader.ts` | Project instruction discovery now checks `CLAUDE.md`, `.cat-code/CLAUDE.md`, and `.cat-code/rules/*.md` before legacy `.claude` fallbacks, across cwd ancestors and additional dirs. |
| Project-keyed user state | `src/utils/config.ts` | `src/utils/git.ts`, `src/utils/path.ts` | `getProjectPathForConfig()` keys by canonical git root when available, otherwise original cwd. Values are stored inside the global config `projects` object, not in repo files. |
| Trust persistence | `src/utils/config.ts` | `src/bootstrap/state.ts`, `src/components/TrustDialog/` | Trust can be session-only for some cases, or persisted as `projects[projectPath].hasTrustDialogAccepted`. Parent-directory checks are part of trust lookup. |
| Legacy config migrations | `src/utils/config.ts` | `src/main.tsx`, `src/migrations/` | `config.ts` has local field migrations and backup behavior. Startup migrations handle renamed settings/config fields elsewhere. |
| Env from settings before trust | `src/utils/managedEnv.ts` | `src/utils/managedEnvConstants.ts`, `src/services/remoteManagedSettings/syncCache.ts` | `applySafeConfigEnvironmentVariables()` applies global config env, all env from trusted user/flag/policy sources, then only `SAFE_ENV_VARS` from merged settings. |
| Env from settings after trust | `src/utils/managedEnv.ts` | `src/utils/proxy.ts`, `src/utils/caCerts.ts`, `src/utils/mtls.ts` | `applyConfigEnvironmentVariables()` applies global config env and full merged settings env, then clears caches and reconfigures proxy/mTLS agents. |
| Session `/env` command state | `src/utils/sessionEnvVars.ts` | Bash/shell provider env assembly | `/env` state is a process memory map for spawned child processes. It is not part of settings or global config. |
| Provider-routing env protection | `src/utils/managedEnv.ts` | `src/utils/managedEnvConstants.ts` | SSH tunnel vars, host-managed provider vars, and desktop spawn env keys are filtered before settings env is assigned. |
| File-based managed settings | `src/utils/settings/settings.ts` | `src/utils/settings/managedPath.ts` | Base `managed-settings.json` merges with `managed-settings.d/*.json` alphabetically. Later drop-ins win within the file-based policy source. |
| MDM/plist/registry policy | `src/utils/settings/mdm/settings.ts` | `src/utils/settings/mdm/rawRead.ts`, `src/utils/settings/mdm/constants.ts` | macOS reads managed preferences; Windows reads HKLM first, then HKCU only if no higher source exists. Linux uses file-based managed settings. |
| Remote managed settings | `src/services/remoteManagedSettings/index.ts` | `src/services/remoteManagedSettings/syncCache.ts`, `src/services/remoteManagedSettings/syncCacheState.ts`, `src/services/remoteManagedSettings/securityCheck.tsx` | Remote settings are cached in `remote-settings.json`, fail open, poll hourly, and notify `policySettings` on change. The sync cache is split to avoid settings/auth import cycles. |
| Policy settings precedence | `src/utils/settings/settings.ts` | `src/utils/settings/mdm/settings.ts`, `src/services/remoteManagedSettings/syncCacheState.ts` | `policySettings` is first-source-wins: remote -> admin MDM/HKLM/plist -> managed settings files/drop-ins -> HKCU. It does not deep-merge across policy sources. |
| Policy limits | `src/services/policyLimits/index.ts` | `src/services/policyLimits/types.ts` | Policy limits are separate from managed settings. They cache in `policy-limits.json`, fail open for most policies, poll hourly, and can fail closed for specific essential-traffic-only policies on cache miss. |
| Settings validation and diagnostics | `src/utils/settings/validation.ts` | `src/utils/settings/allErrors.ts`, `src/utils/settings/validationTips.ts`, `src/screens/Doctor.tsx` | Invalid permission rules can be filtered before schema validation. Use the validation surfaces before inventing new diagnostics. |
| Transcript file path | `src/utils/sessionStorage.ts` | `src/bootstrap/state.ts`, `src/utils/path.ts` | Transcripts live under `getClaudeConfigHomeDir()/projects/<sanitized-project>/<sessionId>.jsonl`. `sessionProjectDir` can override path derivation for resumed sessions. |
| Transcript write path | `src/utils/sessionStorage.ts` | `src/types/logs.ts`, `src/utils/sessionStoragePortable.ts` | `recordTranscript()` dedupes by UUID and maintains parent chains. Progress messages are not chain participants. |
| Transcript metadata entries | `src/utils/sessionStorage.ts` | `src/types/logs.ts` | Titles, tags, agent metadata, mode, worktree state, thread goals, content replacements, file history, attribution, and context-collapse entries are separate JSONL entry types. |
| Resume loading | `src/utils/conversationRecovery.ts` | `src/utils/sessionStorage.ts`, `src/commands/resume/`, `src/screens/ResumeConversation.tsx` | `loadConversationForResume()` loads the latest, a session ID, a `LogOption`, or a JSONL path, then deserializes and runs resume session-start hooks. |
| Resume state restoration | `src/utils/sessionRestore.ts` | `src/screens/REPL.tsx`, `src/main.tsx` | Restore is split between transcript loading and process state: cwd/worktree, mode, cost state, file history, attribution, todos, agent setting, context collapse, and metadata adoption. |
| Forked resume | `src/utils/sessionRestore.ts` | `src/utils/sessionStorage.ts` | `--fork-session` keeps the fresh session ID but must seed content replacements into the new transcript. It should not adopt the source worktree state. |
| Session list and resume picker data | `src/utils/sessionStorage.ts` | `src/utils/sessionStoragePortable.ts`, `src/screens/ResumeConversation.tsx`, `src/screens/REPL.tsx` | Listing uses stat-only and progressive enrichment paths for performance. Enrichment derives the latest meaningful prompt/name and activity time; the active REPL re-appends current session metadata before showing the picker. Do not replace these paths with full transcript reads for picker UI. |
| Subagent transcripts | `src/utils/sessionStorage.ts` | `src/tools/AgentTool/`, `src/tasks/` | Subagent transcript paths live under the session directory and can use registered subdirectories. They are not the same as the main transcript chain. |
| Disabling session persistence | `src/bootstrap/state.ts` | `src/utils/sessionStorage.ts` | `sessionPersistenceDisabled` is session-only. Check this before assuming a missing JSONL means resume is broken. |
| Auto memory enablement | `src/memdir/paths.ts` | `src/memdir/memdir.ts`, `src/services/extractMemories/` | Auto memory is enabled by default but can be disabled by env, `--bare`/simple mode, CCR without remote memory dir, or `autoMemoryEnabled` settings. |
| Auto memory path | `src/memdir/paths.ts` | `src/utils/permissions/filesystem.ts` | Path resolution is override env -> trusted `autoMemoryDirectory` setting -> `<memoryBase>/projects/<sanitized-git-root>/memory/`. Project shared settings are intentionally excluded from path override. |
| Auto memory prompt/content | `src/memdir/memdir.ts` | `src/utils/claudemd.ts`, `src/services/extractMemories/` | `MEMORY.md` is an index and is truncated by line and byte caps when loaded. Assistant/Kairos mode can write daily logs under the memory dir. |
| Team memory | `src/memdir/teamMemPaths.ts` | `src/memdir/teamMemPrompts.ts`, `src/memdir/memoryScan.ts` | Team memory is a subdirectory of auto memory and is gated separately. Write validation resolves symlinks to avoid directory escape. |
| Session memory summaries | `src/services/SessionMemory/sessionMemory.ts` | `src/services/SessionMemory/sessionMemoryUtils.ts`, `src/utils/permissions/filesystem.ts` | Session memory writes `summary.md` under the current project/session directory and runs via a forked agent after thresholds. It is used for the current conversation, not cross-session recall. |
| Memory read/write permission carve-outs | `src/utils/permissions/filesystem.ts` | `src/memdir/paths.ts`, `src/memdir/teamMemPaths.ts` | Default auto-memory paths get special read/write handling. Arbitrary override paths do not get silent write allow; callers need explicit permission rules. |

## Storage Scope Cheat Sheet

| Scope | Primary files | Owner |
|---|---|---|
| Session-only process state | in-memory bootstrap/settings/session env caches | `src/bootstrap/state.ts`, `src/utils/settings/settingsCache.ts`, `src/utils/sessionEnvVars.ts` |
| User-global settings | `~/.cat-code/settings.json` or `~/.cat-code/cowork_settings.json` | `src/utils/settings/settings.ts` |
| User-global config | `${CLAUDE_CONFIG_DIR:-~/.cat-code}/.cat-code*.json`, with legacy `~/.cat-code/.config.json` fallback | `src/utils/env.ts`, `src/utils/config.ts` |
| User-global project-keyed state | global config `projects[canonicalGitRootOrCwd]` | `src/utils/config.ts` |
| Project-shared settings | `.cat-code/settings.json` | `src/utils/settings/settings.ts` |
| Project-local settings | `.cat-code/settings.local.json` | `src/utils/settings/settings.ts` |
| Managed settings files | `/etc/claude-code`, `/Library/Application Support/ClaudeCode`, or `C:\Program Files\ClaudeCode` | `src/utils/settings/managedPath.ts`, `src/utils/settings/settings.ts` |
| Remote managed settings cache | `~/.cat-code/remote-settings.json` | `src/services/remoteManagedSettings/` |
| Policy limits cache | `~/.cat-code/policy-limits.json` | `src/services/policyLimits/index.ts` |
| Session transcript | `~/.cat-code/projects/<sanitized-project>/<sessionId>.jsonl` | `src/utils/sessionStorage.ts` |
| Deferred continuations | `~/.cat-code/deferred-continuations/{pending,history,locks,tmp}` | `src/services/deferredContinuation.ts`, `src/services/deferredContinuationRunner.ts` |
| Session memory | `~/.cat-code/projects/<sanitized-project>/<sessionId>/session-memory/summary.md` | `src/services/SessionMemory/`, `src/utils/permissions/filesystem.ts` |
| Auto memory | `~/.cat-code/projects/<sanitized-git-root>/memory/MEMORY.md` by default | `src/memdir/paths.ts`, `src/memdir/memdir.ts` |
| Team memory | `~/.cat-code/projects/<sanitized-git-root>/memory/team/MEMORY.md` by default | `src/memdir/teamMemPaths.ts` |

## Precedence Summary

Normal merged settings:

1. Plugin settings base from `src/utils/settings/settingsCache.ts`
2. `userSettings`
3. `projectSettings`
4. `localSettings`
5. `flagSettings`
6. `policySettings`

Important exceptions:

- `policySettings` chooses the first populated policy source instead of merging
  every policy source.
- File-based managed settings merge internally: base file first, then drop-ins
  alphabetically.
- Normal settings reads deep-merge objects and concat/dedupe arrays.
- `updateSettingsForSource()` replaces arrays when writing a single editable
  source.
- Env application is not the same as settings merge. Before trust, project and
  local settings can only contribute safe env vars.

## Tests And Validation

| Surface | Focused command |
|---|---|
| Session transcript persistence | `bun test src/utils/sessionStorage.test.ts` |
| Deferred queue, locks, identity, cancellation, and recovery | `bun test src/services/deferredContinuation.test.ts src/services/deferredContinuation.probe.test.ts src/utils/sessionRestore.deferred.test.ts` |
| Full engine gate | `bun run build:dev:full` |

## Recovery And Resume Route

Use this order when debugging missing, stale, or malformed resumed state:

1. `src/utils/sessionStorage.ts`: path derivation, JSONL entries, UUID dedupe,
   parent chain, compact-boundary loading, session metadata.
2. `src/utils/conversationRecovery.ts`: source selection, chain loading,
   deserialization, interrupted-turn handling, resume hooks.
3. `src/utils/sessionRestore.ts`: active session switch, worktree/cwd restore,
   metadata adoption, mode/agent restore, context-collapse restore.
4. `src/screens/REPL.tsx`, `src/main.tsx`, `src/commands/resume/`: interactive
   and CLI entry behavior.

Do not treat `src/history.ts` or prompt input history as transcript truth.

## Traps And Stale Assumptions

- Global config and settings are different files with different schemas.
  `settings.env` is preferred over deprecated global config `env`, but both can
  still be applied by `managedEnv.ts`.
- The settings merge order and env application order deliberately differ for
  trust and provider-safety reasons.
- Remote managed settings eligibility is computed after user/flag env is
  applied so provider/base-url env can affect the remote-policy decision.
- Remote managed settings and policy limits fail open by design, but stale
  caches may still apply when fetches fail.
- `policySettings` is first-source-wins. Adding a lower-priority managed file
  will not matter if remote or admin MDM settings are populated.
- `flagSettings` and `policySettings` are always loaded even when
  `--setting-sources` narrows user/project/local settings.
- Settings file hot reload can be blocked by `ConfigChange` hooks.
- `changeDetector.fanOut()` is the cache-reset owner before settings subscribers
  run. Do not reintroduce per-listener `getInitialSettings()` cache resets in
  `applySettingsChange()` or adjacent subscribers.
- `applySettingsChange()` reloads `settings` plus permission context only. Do
  not treat disk-backed `settings.effortLevel` as the owner of
  `AppState.effortValue`; session-scoped `/effort` state is updated by the
  command/UI path instead.
- Do not treat `settings.fastMode` as the current-session fast-mode toggle.
  `getInitialFastModeSetting()` starts sessions off, and `/fast` plus Settings
  Config mutate `AppState.fastMode` directly.
- Internal settings writes are suppressed from watcher notifications for a short
  window; do not expect every write to produce UI reload churn.
- Project config keys are keyed by canonical git root when possible, so
  worktrees can share project-keyed global config state.
- Transcript path derivation can be overridden by `sessionProjectDir` after
  resume. Use `getTranscriptPathForSession()` and `switchSession()` paths rather
  than rebuilding paths by hand.
- Progress entries are UI state and should not participate in transcript parent
  chains.
- Session memory, auto memory, team memory, CLAUDE.md instruction memory, and
  transcript JSONL files are separate persistence systems.
- Auto-memory path overrides do not get the default silent write permission
  carve-out. That is intentional.
- `getAutoMemPath()` and settings readers are memoized/cached. Tests and
  hot-reload code must reset the right cache instead of assuming fresh disk
  reads.
- `--bare`/simple mode disables broad startup behavior and auto memory gates;
  do not diagnose absent memory only from file paths.
- Global config writes create backups and filter default-valued keys. Missing
  fields in the file can be intentional defaults, not lost state.

## When Adding Persistence

- Decide the scope first: session-only, user-global, project-shared,
  project-local, admin-managed, transcript, or memory.
- Reuse the existing owner for that scope rather than creating a new root file.
- Add schema/validation in the same layer that reads the file.
- Add hot-reload handling only if mid-session changes should apply.
- For anything user-visible on resume, persist enough metadata in the JSONL
  entry stream and restore it in both interactive and CLI resume paths.
- For settings that affect subprocess env, update `managedEnv.ts` consciously;
  changing settings schema alone is not enough.
