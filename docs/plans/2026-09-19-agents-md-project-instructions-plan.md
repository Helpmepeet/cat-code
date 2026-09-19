# AGENTS.md project-instructions implementation plan

**Date:** 2026-09-19  
**Status:** Proposed. No runtime code is changed by this document.

## Summary

Add Claude Code 2.1.277-style `AGENTS.md` support to Cat Code.

The default behavior should be:

- keep using `CLAUDE.md` when the current project has one of Cat Code's own CLAUDE instruction files;
- otherwise load `AGENTS.md` as project instructions;
- expose a **Project instructions** picker in `/config`;
- support the same four mode values as upstream:
  `claude-md`, `claude-md-or-agents-md`,
  `claude-md-and-agents-md`, and `managed-only`.

Do this in Cat Code's existing instruction loader instead of porting Claude Code's
new built-in mod/hook runtime. Cat Code already owns instruction discovery in
`src/utils/claudemd.ts`, and the upstream `prompt.context` / `tool.call`
mod interfaces are not present in this tree.

## Upstream reference

This plan was checked against Anthropic's public `mods/agents-md`
implementation at commit
`92ec78f288a5c08660c6c5c2689c1a1ef4b76d3b`.

Relevant upstream files:

- `mods/agents-md/README.md`
- `mods/agents-md/.claude-plugin/plugin.json`
- `mods/agents-md/hooks/register.ts`
- `mods/agents-md/hooks/modes/*`
- `mods/agents-md/hooks/names/*`
- `mods/agents-md/hooks/files/*`

The important upstream contract is the mode name and setting path:

```json
{
  "pluginConfigs": {
    "agents-md@builtin": {
      "options": {
        "instructionFiles": "claude-md-or-agents-md"
      }
    }
  }
}
```

Cat Code should keep that storage shape even though the behavior is implemented
inside its loader. This gives settings compatibility with current Claude Code and
keeps a future upstream sync simpler.

## Current Cat Code behavior

The current instruction owner is `src/utils/claudemd.ts`.

It eagerly loads, in priority order:

1. managed CLAUDE instructions and rules;
2. user CLAUDE instructions and rules;
3. project `CLAUDE.md`, `.cat-code/CLAUDE.md`,
   `.claude/CLAUDE.md`, and project rules while walking root to CWD;
4. `CLAUDE.local.md`;
5. optional additional-directory CLAUDE instructions;
6. auto-memory and team-memory indexes.

Nested instruction discovery uses
`getMemoryFilesForNestedDirectory()`, while
`isMemoryFilePath()` identifies instruction files already present in read-file
state.

`processMemoryFile()` already supplies the important common behavior:

- source typing and prompt framing;
- `@include` handling;
- circular-include protection;
- external-include approval;
- symlink-aware path deduplication;
- `claudeMdExcludes` filtering.

The AGENTS implementation should reuse this path rather than create a second
parser.

## Product behavior

### Modes

| Mode | Behavior |
| --- | --- |
| `claude-md` | Preserve today's Cat Code behavior. Ignore AGENTS files. |
| `claude-md-or-agents-md` | Default. If the active project walk has no enabled CLAUDE instruction file of its own, load AGENTS files instead. |
| `claude-md-and-agents-md` | Load AGENTS files beside the normal CLAUDE instruction files. |
| `managed-only` | Keep managed instructions and recalled memory, but omit user, project, local, AGENTS, and project/user rules. |

### Files that count as a CLAUDE instruction in Cat Code

For fallback detection, Cat Code should count the instruction files it already
supports:

- `CLAUDE.md`
- `.cat-code/CLAUDE.md`
- `.claude/CLAUDE.md`
- `CLAUDE.local.md`

A file only counts when its setting source is enabled. For example,
`CLAUDE.local.md` should not suppress AGENTS fallback when `localSettings`
is disabled.

Project rule files do **not** suppress AGENTS fallback. Managed instructions,
user-global instructions, and additional-directory instructions also do not make
the current project a CLAUDE project.

Fallback detection should be based on file presence, not on whether the file later
produces injected text. This matches upstream's behavior where a project-owned
CLAUDE file can make the fallback stand down even if another layer later withholds
it.

### AGENTS filenames

Match upstream for the first version:

- `AGENTS.md`
- `.claude/AGENTS.md`

Do not invent `.cat-code/AGENTS.md` yet. The portable convention is
`AGENTS.md`, and upstream explicitly supports the two names above.

Cat Code's existing `.cat-code/CLAUDE.md` still counts as a CLAUDE claim for
fallback because Cat Code already treats it as a first-class project instruction.

### Initial root-to-CWD load

For `claude-md-or-agents-md`:

1. Build the same root-to-CWD directory list used today, including the nested
   worktree skip rule.
2. Check for any enabled project/local CLAUDE instruction on that walk.
3. If one exists, use the current loader unchanged for project/local instructions.
4. If none exists, load `AGENTS.md` and `.claude/AGENTS.md` in each eligible
   directory as `Project` memory, in root-to-CWD order.
5. Continue loading project rules normally.

For `claude-md-and-agents-md`, keep the current CLAUDE files and insert AGENTS
files in the same directory slot after the existing CLAUDE files and before files
from a deeper directory. Processing CLAUDE first also lets the existing
`processedPaths` mechanism suppress an AGENTS file already pulled in through a
CLAUDE `@include`.

### Nested directories

Update `getMemoryFilesForNestedDirectory()` so a later file read sees the same
mode semantics below the starting CWD.

In fallback mode, a nested directory's CLAUDE instruction wins for that directory.
If that directory has a CLAUDE instruction, do not also attach its AGENTS file.
A deeper directory without its own CLAUDE file can still contribute AGENTS.

In both mode, attach both families using the same once-per-path processing and
priority rules.

In managed-only mode, nested project/local instructions and project rules must not
re-enter through this path.

### Includes, excludes, and memory-file identity

AGENTS files should use `processMemoryFile()`. This means they inherit the same
include parser and the same external-include security checks.

`claudeMdExcludes` should also apply to AGENTS paths. Keep the setting key for
compatibility, but update its schema description to say it excludes instruction
files rather than only CLAUDE files.

Update `isMemoryFilePath()` so `AGENTS.md` and
`.claude/AGENTS.md` are recognized by read-file state and `/context`-related
instruction tracking.

The existing external-include approval state fields can keep their historical
`ClaudeMd` names to avoid a persistence migration, but user-facing text should
say **project instruction file** rather than only `CLAUDE.md`.

### Additional directories

Keep AGENTS loading out of `--add-dir` in the first implementation.

Current upstream 2.1.277 also does not add AGENTS from additional directories.
Keeping that limit in v1 reduces semantic drift and avoids inventing a second
fallback scope. A later change can make additional directories fully symmetric
once the desired rule is explicit.

### Provider behavior

Do not add a Bedrock, Vertex, Foundry, Claude, or OpenAI-specific gate.

Cat Code injects instruction files before provider assembly, so this feature can
remain provider-neutral. Upstream's initial provider limitation comes from its
delivery mechanism, not from AGENTS file semantics.

## Settings design

### Resolver

Add a small owner module, for example
`src/utils/instructionFiles.ts`, containing:

- `InstructionFilesMode`
- `INSTRUCTION_FILES_MODES`
- `DEFAULT_INSTRUCTION_FILES_MODE`
- `resolveInstructionFilesMode()`
- helpers for reading and writing the nested plugin option safely

The resolver should accept only the four current values. Missing or invalid values
fall back to `claude-md-or-agents-md`.

Read this option from the sources Claude Code supports for this built-in option:

1. user settings;
2. flag/`--settings` settings;
3. policy settings.

Later sources win. Ignore project and local settings for this option so a
repository cannot silently change which instruction-file family Cat Code trusts.

The resolver should return source information as well as the mode so `/config`
can show a managed/session override as read-only instead of letting the user make a
write that cannot win.

Do not add support for the old upstream `projectInstructions` option in the
first Cat Code version. Cat Code never shipped that key. Add the compatibility
alias only if an import/migration path is found that can place it in Cat Code
settings.

### /config

Add a `Project instructions` row in
`src/components/Settings/Config.tsx`.

Use a small picker rather than exposing raw enum strings. Suggested labels:

| Label | Stored value |
| --- | --- |
| CLAUDE.md or AGENTS.md | `claude-md-or-agents-md` |
| CLAUDE.md only | `claude-md` |
| CLAUDE.md and AGENTS.md | `claude-md-and-agents-md` |
| Managed instructions only | `managed-only` |

The default item should say that AGENTS is used only when the project has no own
CLAUDE instruction file.

Write changes to user settings with the updater form of
`updateSettingsForSource()`. Preserve unrelated plugin config, plugin options,
and MCP config while changing only
`pluginConfigs["agents-md@builtin"].options.instructionFiles`.

After a successful write:

- refresh the Config component's displayed mode;
- clear `getMemoryFiles` through `clearMemoryFileCaches()`, because internal
  settings writes are intentionally hidden from the file watcher;
- make the next context rebuild use the new instruction family.

Add the nested plugin option to Config's Escape/revert snapshot so opening
`/config`, changing the value, then cancelling restores the exact prior
user-setting value without overwriting unrelated concurrent plugin changes.

If policy or `--settings` owns the effective mode, show the effective value and
make the picker read-only with a short source note.

## File-by-file implementation

### 1. `src/utils/instructionFiles.ts` and tests

Create the mode and setting resolver.

Tests:

- unset value gives fallback mode;
- each valid value round-trips;
- invalid value gives fallback mode;
- project/local values are ignored;
- flag overrides user;
- policy overrides flag;
- nested plugin writes preserve sibling plugin config/options;
- deleting/restoring the user option does not remove unrelated plugin state.

### 2. `src/utils/claudemd.ts`

Refactor the repeated project filename logic into small helpers before adding new
branches. Keep the existing load order stable for `claude-md`.

Add:

- project CLAUDE candidate names;
- AGENTS candidate names;
- project-walk fallback detection;
- AGENTS loading for eager discovery;
- AGENTS loading for nested directories;
- managed-only gates for user/project/local instruction and rule paths;
- AGENTS recognition in `isMemoryFilePath()`.

Do not fork `processMemoryFile()`.

The `claude-md` mode must produce the same `MemoryFileInfo[]` as before.

### 3. Discovery tests

The current `src/utils/claudemd.test.ts` mostly covers prompt framing, so add a
focused discovery test file rather than turning the framing test into a large
filesystem suite.

Cover this matrix:

| Case | Expected |
| --- | --- |
| no CLAUDE, root AGENTS | AGENTS loads by default |
| root CLAUDE + root AGENTS | CLAUDE loads, AGENTS does not |
| `.cat-code/CLAUDE.md` + AGENTS | Cat Code CLAUDE path suppresses fallback |
| `.claude/CLAUDE.md` + AGENTS | CLAUDE suppresses fallback |
| `CLAUDE.local.md` enabled + AGENTS | local CLAUDE suppresses fallback |
| local settings disabled + only `CLAUDE.local.md` + AGENTS | AGENTS can load |
| project rule + AGENTS, no CLAUDE | rule and AGENTS both load |
| both mode | CLAUDE and AGENTS both load in deterministic order |
| claude-only mode | byte-for-byte current instruction discovery behavior |
| managed-only mode | managed + recalled memory only |
| parent and child AGENTS | root first, child later/higher priority |
| nested read under child AGENTS | child AGENTS attaches once |
| nested directory with CLAUDE + AGENTS in fallback | nested CLAUDE wins there |
| CLAUDE imports AGENTS in both mode | no duplicate explicit AGENTS entry |
| AGENTS imports an external file | same approval gate as CLAUDE |
| `claudeMdExcludes` matches AGENTS | AGENTS is omitted |
| nested worktree | main-repo duplicate project AGENTS is skipped |
| additional directory with AGENTS only | no AGENTS in v1 |

Also assert that loaded AGENTS files have `type: "Project"` so existing framing,
subagent omission, and context display rules treat them exactly like project
instructions.

### 4. `src/components/Settings/Config.tsx`

Add the row, picker integration, write/revert behavior, and cache invalidation.

Add focused UI tests for:

- default value display;
- selecting all four modes;
- persisted nested plugin option;
- cancel restores the prior value;
- managed/flag-owned value cannot be overridden from the picker.

### 5. External include UI

Update user-facing copy in
`src/components/ClaudeMdExternalIncludesDialog.tsx` and the Config row from
CLAUDE-only wording to project-instruction wording.

Keep persisted field names and existing analytics event names unless a separate
analytics migration is required.

### 6. Settings schema text

No new schema shape is required because `pluginConfigs.*.options` already accepts
string options.

Update the `claudeMdExcludes` description in
`src/utils/settings/types.ts` so AGENTS paths are documented as supported.

### 7. Documentation

Update:

- `docs/prompts/2026-04-30-prompt-surfaces.md`
- `docs/maps/prompt-system.md`
- `docs/maps/config-persistence.md`

Document:

- the four modes and default;
- the upstream-compatible settings path;
- Cat Code's `.cat-code/CLAUDE.md` fallback claim;
- AGENTS filenames supported in v1;
- additional-directory limitation;
- the fact that AGENTS enters the same `Project` instruction framing as CLAUDE.

## Cache and context behavior

Changing the mode in `/config` must not require a process restart.

The write path already resets the settings cache. The Config handler also needs to
clear the memoized memory-file list. The next user turn should rebuild instruction
context with the new mode.

Do not fire a false `InstructionsLoaded` lifecycle event merely because the
cache was invalidated by Config. Use the existing correctness-only
`clearMemoryFileCaches()` path, not the compaction-oriented reset path.

## Telemetry

Do not add content, paths, or filenames to analytics.

If product telemetry is wanted, record only the closed mode value when the user
changes the picker. This is optional for the first implementation and should not
block the feature.

## Verification

Focused checks:

```sh
bun test src/utils/instructionFiles.test.ts
bun test src/utils/claudemd.test.ts src/utils/claudemd.discovery.test.ts
bun test src/components/Settings/
```

Then run:

```sh
bun run build:dev:full
```

For the documentation-only planning commit:

```sh
git diff --check
bun run maps:lint
```

## Acceptance criteria

The feature is complete when all of these are true:

1. A fresh project containing only `AGENTS.md` gets those instructions with no
   user action.
2. A project with an enabled Cat Code CLAUDE instruction keeps current behavior
   by default and does not also load AGENTS.
3. `/config` exposes **Project instructions** and persists the four upstream
   mode values in the upstream-compatible setting path.
4. Both mode loads the two instruction families without duplicate imports.
5. Managed-only cannot leak user/project/local instructions back through nested
   rule or read paths.
6. AGENTS uses the same framing, include security, excludes, ordering, worktree
   handling, and subagent project-instruction semantics as existing CLAUDE files.
7. Changing the mode takes effect on the next context rebuild without restarting
   Cat Code.
8. Existing CLAUDE-only behavior remains regression-tested.
9. No provider-specific prompt assembly change is needed.
