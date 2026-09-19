# AGENTS.md project-instructions implementation plan

**Date:** 2026-09-19  
**Status:** Revised after adversarial review. No runtime code is changed by this document.

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
- path tracking plus symlink resolution for includes;
- `claudeMdExcludes` filtering.

One existing edge matters for this feature: `processMemoryFile()` checks the
spelled path before resolving a symlink, but does not re-check whether the resolved
path is already in `processedPaths`. Therefore an `AGENTS.md` symlink to an
already-loaded `CLAUDE.md` can currently be injected twice unless this is fixed.
The implementation must close that gap before relying on the shared dedupe path.

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

### Fallback eligibility invariant

Fallback eligibility is **project-global for the active root-to-CWD project**.

Compute one `hasProjectClaudeClaim` decision from the eligible root-to-CWD walk.
In `claude-md-or-agents-md` mode:

- if `hasProjectClaudeClaim` is true, AGENTS is disabled for both eager loading
  and every nested read under that active project;
- if it is false, the project qualifies for AGENTS fallback, root-to-CWD AGENTS
  files may load, and only then do directories below CWD arbitrate locally between
  nested CLAUDE and AGENTS files.

This state must be recomputed when the active project/root changes and whenever the
instruction-mode/settings cache is invalidated. It must not be inferred separately
for every nested read.

Critical regression:

```text
root/CLAUDE.md
root/child/AGENTS.md
Read root/child/file.ts
=> child/AGENTS.md does not load
```

The nested local arbitration rule applies only to a project that already qualified
for fallback.

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
2. Compute `hasProjectClaudeClaim` only from directories that are eligible after
   that worktree/source filtering.
3. If the claim is true, use the current CLAUDE project/local loader and mark the
   active project ineligible for nested AGENTS fallback.
4. If the claim is false, load `AGENTS.md` and `.claude/AGENTS.md` in each
   eligible directory as `Project` memory, in root-to-CWD order and mark the
   active project eligible for nested AGENTS fallback.
5. Continue loading project rules normally.

For `claude-md-and-agents-md`, keep the current CLAUDE files and insert AGENTS
files in the same directory's project-instruction slot.

Pin the exact within-directory order to:

1. `CLAUDE.md`
2. `.cat-code/CLAUDE.md`
3. `.claude/CLAUDE.md`
4. `AGENTS.md`
5. `.claude/AGENTS.md`
6. `.cat-code/rules/*.md` unconditional rules
7. `.claude/rules/*.md` unconditional rules
8. `CLAUDE.local.md`

Then continue to the next deeper directory. This preserves Cat Code's existing
CLAUDE → rules → local priority while giving AGENTS the same project-instruction
slot, immediately after the CLAUDE candidates and before rules/local.

### Nested directories

Update `getMemoryFilesForNestedDirectory()` so a later file read uses the same
project-global fallback decision as eager discovery.

In fallback mode:

1. Check the active project's cached/recomputed `hasProjectClaudeClaim`.
2. If true, return no AGENTS files from nested discovery anywhere under that
   project. Existing nested CLAUDE behavior remains.
3. If false, the project is an AGENTS-fallback project. For each directory below
   CWD, check that directory's CLAUDE candidates first. A CLAUDE claim in that
   directory suppresses AGENTS for that directory only; a deeper directory with no
   claim may still contribute AGENTS.

The per-directory nested claim set must explicitly include all Cat Code filenames:
`CLAUDE.md`, `.cat-code/CLAUDE.md`, `.claude/CLAUDE.md`, and
`CLAUDE.local.md`. `CLAUDE.local.md` only counts when `localSettings` is
enabled.

In both mode, attach both families using the same once-per-path/content processing
and exact ordering rules.

In managed-only mode, nested project/local instructions, project rules, and
root-to-CWD conditional project rules must not re-enter through any attachment
path.

### Includes, excludes, and memory-file identity

AGENTS files should use `processMemoryFile()`. This means they inherit the same
include parser and the same external-include security checks.

Before adding AGENTS, fix the resolved-path dedupe hole in
`processMemoryFile()`: after `safeResolvePath()`, normalize the resolved path
and return early when that canonical path is already processed. Only then add the
spelled path and canonical path to `processedPaths`. Add a regression where
`AGENTS.md` is a symlink to an already-loaded `CLAUDE.md` and only one project
instruction is produced.

For upstream parity in `claude-md-and-agents-md`, also dedupe an AGENTS
candidate when its trimmed content is identical to an already accepted
`Project` instruction. Scope this content comparison to AGENTS admission rather
than globally collapsing unrelated managed/user/local files. Cover both a symlink
alias and a separate copied file with identical content.

`claudeMdExcludes` should also apply to AGENTS paths. Keep the setting key for
compatibility, but update its schema description to say it excludes instruction
files rather than only CLAUDE files.

Do **not** make every manually-read `AGENTS.md` an instruction merely because
its filename matches. `getAllMemoryFilePaths()` currently supplements eager files
from `readFileState`; an unconditional AGENTS match would make manually read
AGENTS appear as instruction/memory tracking in `claude-md`, `managed-only`,
or fallback projects already claimed by CLAUDE.

Make AGENTS identity admission-aware. Prefer tracking paths that were actually
accepted by eager/nested instruction discovery, or pass the effective mode plus
project fallback eligibility into the read-file-state classification. Tests must
show that a manual AGENTS read is not treated as an instruction in `claude-md`,
`managed-only`, or an ineligible fallback project.

The existing external-include approval state fields can keep their historical
`ClaudeMd` names to avoid a persistence migration, but user-facing text should
say **project instruction file** rather than only `CLAUDE.md`.

### Additional directories

Keep AGENTS loading out of `--add-dir` in the first implementation.

Current upstream 2.1.277 also does not add AGENTS from additional directories.
Keeping that limit in v1 reduces semantic drift and avoids inventing a second
fallback scope. A later change can make additional directories fully symmetric
once the desired rule is explicit.

`managed-only` must explicitly bypass the existing additional-directory CLAUDE
block as well. That block intentionally ignores
`isSettingSourceEnabled('projectSettings')`, so managed-only cannot be
implemented only by disabling normal project/user/local discovery. In
managed-only, additional-directory `CLAUDE.md`, `.cat-code/CLAUDE.md`,
`.claude/CLAUDE.md`, `.cat-code/rules/*.md`, and
`.claude/rules/*.md` must all stay out.

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

The resolver should accept only the four current values.

Read this option from the sources Claude Code supports for this built-in option:

1. user settings, but only when `isSettingSourceEnabled('userSettings')` is
   true;
2. flag/`--settings` settings;
3. policy settings.

Flag and policy remain available under Cat Code's current source rules even when
user/project/local setting sources are narrowed. Ignore project and local settings
for this option so a repository cannot silently change which instruction-file
family Cat Code trusts.

Precedence is presence-first, then validation:

- find the highest-priority **present** source;
- validate only that source's value;
- a valid value wins;
- a missing value falls through to the next source;
- an invalid value at the winning source resolves to the default
  `claude-md-or-agents-md`; it does **not** expose a lower-priority valid value.

This makes malformed flag/managed input deterministic and avoids unexpectedly
activating a lower-priority user choice.

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
- user value is ignored when `userSettings` is disabled;
- project/local values are ignored;
- flag overrides user;
- policy overrides flag;
- invalid flag over valid user resolves to the default, not the user value;
- invalid policy over valid flag resolves to the default, not the flag value;
- nested plugin writes preserve sibling plugins, sibling options, MCP config, and
  an unknown future per-plugin field;
- deleting/restoring the user option does not remove unrelated plugin state.

### 2. `src/utils/claudemd.ts`

Refactor the repeated project filename logic into small helpers before adding new
branches. Keep the existing load order stable for `claude-md`.

Add:

- project CLAUDE candidate names;
- AGENTS candidate names;
- one project-global fallback eligibility decision for the active root-to-CWD
  walk;
- AGENTS loading for eager discovery;
- AGENTS loading for nested directories only when the active project qualified;
- explicit managed-only gates for user/project/local instruction paths, eager and
  conditional rules, nested paths, and additional-directory paths;
- resolved-path re-check in `processMemoryFile()`;
- project-content dedupe for AGENTS admission in both mode;
- admission-aware AGENTS instruction identity for context/memory tracking.

Do not fork `processMemoryFile()`.

The `claude-md` mode must produce the same `MemoryFileInfo[]` as before except
for the resolved-symlink duplicate bug fix, which needs its own regression.

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
| root CLAUDE + child AGENTS + nested Read | child AGENTS never loads because fallback is project-global |
| eligible fallback project + nested `CLAUDE.md` + AGENTS | nested CLAUDE wins in that directory |
| eligible fallback project + nested `.cat-code/CLAUDE.md` + AGENTS | Cat Code CLAUDE path wins in that directory |
| eligible fallback project + nested `.claude/CLAUDE.md` + AGENTS | legacy CLAUDE path wins in that directory |
| eligible fallback project + nested `CLAUDE.local.md` + AGENTS | local CLAUDE wins when local settings are enabled |
| same nested local case with local settings disabled | AGENTS may load |
| nested read under child AGENTS | child AGENTS attaches once |
| CLAUDE imports AGENTS in both mode | no duplicate explicit AGENTS entry |
| AGENTS symlink -> already-loaded CLAUDE in both mode | one project instruction |
| separate AGENTS copy with identical CLAUDE project content in both mode | one project instruction for upstream parity |
| AGENTS imports an external file | same approval gate as CLAUDE |
| `claudeMdExcludes` matches AGENTS | AGENTS is omitted |
| nested worktree | main-repo duplicate project AGENTS is skipped |
| nested worktree where skipped main-repo CLAUDE exists but worktree has AGENTS | skipped CLAUDE does not suppress worktree AGENTS fallback |
| additional directory with AGENTS only | no AGENTS in v1 |
| managed-only + additional directory with CLAUDE and rules | none of those additional-directory instructions load |
| manual AGENTS read in claude-only | path is not treated as instruction memory |
| manual AGENTS read in managed-only | path is not treated as instruction memory |
| manual AGENTS read in fallback project already claimed by CLAUDE | path is not treated as instruction memory |
| root + child with CLAUDE, AGENTS, rules, and local | exact full `MemoryFileInfo.path[]` order matches the pinned order above |

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

### 6. Settings schema and preservation

No new option value schema is required because `pluginConfigs.*.options` already
accepts string values.

However, the current per-plugin `z.object({ mcpServers, options })` is not
passthrough even though the outer Settings schema is. Parsing can therefore strip
an unknown future field before an updater writes the object back. Before claiming
that the Config updater preserves unrelated plugin config, make the per-plugin
object preserve unknown keys, preferably with `.passthrough()`, and add a
round-trip regression containing:

- the `agents-md@builtin` option;
- a sibling option;
- MCP config;
- a sibling plugin;
- an unknown future field on the same plugin object.

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
clear the memoized eager memory-file list.

That is not sufficient for nested instructions. `attachments.ts` dedupes nested
instruction delivery with both `loadedNestedMemoryPaths` and `readFileState`.
A mode change must invalidate the instruction-delivery state needed for AGENTS
without accidentally discarding ordinary file-read state.

Define one mode-change invalidation path that:

- clears/recomputes the project-global fallback eligibility;
- clears eager `getMemoryFiles` through `clearMemoryFileCaches()`;
- removes or generations-invalidates previously delivered nested AGENTS paths so
  switching back to an AGENTS-enabled mode can deliver them again;
- prevents stale AGENTS from being considered active after switching to
  `claude-md` or `managed-only`;
- does not cause unrelated nested CLAUDE files to be redundantly reinjected unless
  required by the chosen generation design.

Add transition tests for:

- `claude-md-and-agents-md → claude-md`;
- `claude-md → claude-md-or-agents-md`;
- `claude-md-and-agents-md → claude-md → claude-md-and-agents-md`.

The final transition is the regression for stale `loadedNestedMemoryPaths`
blocking AGENTS re-delivery.

Do not fire a false `InstructionsLoaded` lifecycle event merely because the
cache was invalidated by Config. Use the existing correctness-only
`clearMemoryFileCaches()` path for eager state, not the compaction-oriented reset
path.

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
4. Fallback eligibility is project-global: any eligible root-to-CWD CLAUDE claim
   disables nested AGENTS fallback for that project.
5. Both mode loads the two instruction families without path, symlink, import, or
   upstream-equivalent project-content duplicates.
6. Managed-only cannot leak user/project/local instructions through eager,
   conditional-rule, nested-read, or additional-directory paths.
7. AGENTS uses the same framing, include security, excludes, pinned ordering,
   worktree handling, and subagent project-instruction semantics as existing
   CLAUDE files.
8. Changing the mode takes effect on the next context rebuild without restarting
   Cat Code, including after nested AGENTS was already delivered earlier in the
   session.
9. Manually reading an AGENTS file does not make it instruction memory in modes or
   projects where AGENTS is not admitted.
10. Disabled user settings and invalid higher-priority flag/policy values follow
    the explicit resolver semantics above.
11. Plugin-setting writes preserve sibling plugins/options/MCP data and unknown
    future per-plugin fields.
12. Existing CLAUDE-only behavior remains regression-tested.
13. No provider-specific prompt assembly change is needed.
