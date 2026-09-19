# AGENTS.md project-instructions implementation plan

**Date:** 2026-09-19  
**Status:** Simplified v1 plan. No runtime code is changed by this document.

## Goal

Add the normal project-instruction behavior:

```text
if the active project has a Cat Code CLAUDE instruction:
    use CLAUDE instructions
else:
    use AGENTS instructions
```

Also expose the upstream-style **Project instructions** setting in `/config`.

The implementation should stay inside Cat Code's existing instruction loader. Do
not port Anthropic's new mod/hook system and do not create a second instruction
pipeline.

## Scope

### In v1

Support these four values:

| Stored value | UI meaning |
| --- | --- |
| `claude-md-or-agents-md` | CLAUDE.md or AGENTS.md. Default. |
| `claude-md` | CLAUDE.md only. |
| `claude-md-and-agents-md` | CLAUDE.md and AGENTS.md. |
| `managed-only` | Managed instructions only. |

Keep the upstream-compatible settings location:

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

Support these AGENTS filenames:

- `AGENTS.md`
- `.claude/AGENTS.md`

Reuse Cat Code's existing CLAUDE instruction names:

- `CLAUDE.md`
- `.cat-code/CLAUDE.md`
- `.claude/CLAUDE.md`
- `CLAUDE.local.md`

### Explicitly not in v1

Do not add:

- `.cat-code/AGENTS.md`;
- AGENTS discovery from `--add-dir`;
- old upstream `projectInstructions` compatibility;
- content-based dedupe of separate files that happen to contain identical text;
- a new nested-instruction generation/cache framework;
- telemetry for the new setting;
- provider-specific behavior;
- a general plugin-settings schema redesign.

These can be added later if they solve a real problem.

## Core semantics

### 1. Default fallback is project-global

The important invariant is:

> In `claude-md-or-agents-md`, the active root-to-CWD project either qualifies
> for AGENTS fallback or it does not.

Use one helper that checks the eligible root-to-CWD walk for a Cat Code CLAUDE
claim.

A CLAUDE claim is one of the four CLAUDE names above, with its corresponding
setting source enabled. In particular, `CLAUDE.local.md` only counts when
`localSettings` is enabled.

If a root-to-CWD CLAUDE claim exists:

- load current CLAUDE behavior;
- do not eagerly load AGENTS;
- do not load nested AGENTS later under that project.

If no root-to-CWD CLAUDE claim exists:

- load root-to-CWD AGENTS as `Project` instructions;
- nested directories may contribute AGENTS.

Do not introduce mutable project-fallback state just for this feature. Prefer a
small helper that computes the claim from the current CWD/worktree using the same
eligible-directory logic as discovery. This keeps project changes and setting
changes correct without a new invalidation system.

Critical regression:

```text
root/CLAUDE.md
root/child/AGENTS.md
Read root/child/file.ts
=> child/AGENTS.md is not injected
```

### 2. Nested behavior

Only a project that qualified for AGENTS fallback may load nested AGENTS.

For each directory below CWD in such a project:

1. check that directory's enabled CLAUDE candidates;
2. if the directory has a CLAUDE claim, use its CLAUDE instruction and do not
   use AGENTS from that directory;
3. otherwise load `AGENTS.md` and `.claude/AGENTS.md` from that directory.

A deeper directory is evaluated independently after the project has qualified.
For example, a nested CLAUDE file can claim one directory while a deeper directory
without CLAUDE can still supply AGENTS.

For `claude-md-and-agents-md`, load both families.

For `claude-md`, keep today's nested CLAUDE behavior and ignore AGENTS.

For `managed-only`, nested project/local instructions and project rules return
nothing.

### 3. Managed-only must cover every current project/user entry path

`managed-only` keeps managed instructions and recalled memory, but skips:

- user `CLAUDE.md` and user rules;
- project CLAUDE files;
- local CLAUDE files;
- AGENTS files;
- project rules;
- CWD-level conditional project rules;
- nested project/local instructions and rules;
- additional-directory CLAUDE files and rules.

The additional-directory block needs an explicit mode gate because it currently
bypasses `isSettingSourceEnabled('projectSettings')`.

### 4. Reuse the existing parser

Load AGENTS through `processMemoryFile()`.

That gives AGENTS the existing:

- `Project` instruction framing;
- `@include` handling;
- external-include approval;
- `claudeMdExcludes` behavior;
- frontmatter/comment processing;
- normal path tracking.

Do not make a separate AGENTS parser.

### 5. Fix only the concrete symlink duplicate bug

Before relying on the shared path tracking, fix this existing edge in
`processMemoryFile()`:

1. check the spelled path as today;
2. resolve the path;
3. normalize the resolved path;
4. if the resolved path is already in `processedPaths`, return early;
5. otherwise add both spellings and continue.

This is enough to prevent:

```text
CLAUDE.md
AGENTS.md -> CLAUDE.md
```

from producing the same instruction twice in `claude-md-and-agents-md`.

Do not add general same-content dedupe in v1.

### 6. Ordering

Keep Cat Code's current priority shape. Within each directory use:

1. `CLAUDE.md`
2. `.cat-code/CLAUDE.md`
3. `.claude/CLAUDE.md`
4. `AGENTS.md`
5. `.claude/AGENTS.md`
6. `.cat-code/rules/*.md`
7. `.claude/rules/*.md`
8. `CLAUDE.local.md`

Then continue to the next deeper directory.

One regression test should assert the final `MemoryFileInfo.path[]` order.

## Settings behavior

Create a small helper module, for example:

`src/utils/instructionFiles.ts`

It should own:

- `InstructionFilesMode`;
- the four valid values;
- the default value;
- reading the effective mode;
- updating only the user-owned nested option.

### Source rules

Read only:

1. user settings, when `userSettings` is enabled;
2. flag/`--settings`;
3. policy settings.

Ignore project and local settings for this option. A repository must not be able
to change which instruction-file family Cat Code trusts.

Flag and policy are higher priority than user settings.

For an invalid higher-priority present value, use the default instead of falling
through to a lower-priority source. This gives deterministic behavior without a
large compatibility layer.

### /config

Add **Project instructions** to `src/components/Settings/Config.tsx`.

Display friendly labels:

- **CLAUDE.md or AGENTS.md**
- **CLAUDE.md only**
- **CLAUDE.md and AGENTS.md**
- **Managed instructions only**

Write the choice into user settings while preserving the existing
`pluginConfigs` object.

If flag or policy settings own the effective value, show that value as read-only.

Use Config's existing targeted revert pattern so Escape restores only the original
user `instructionFiles` option instead of overwriting the whole settings file.

## Cache behavior

Keep this simple.

After `/config` successfully changes the user option:

- the settings write already resets the settings cache;
- call `clearMemoryFileCaches()` so eager instruction discovery is recalculated.

Do not add a new generation system for `loadedNestedMemoryPaths` in v1.

A mode change controls **future instruction discovery**. It does not attempt to
remove an AGENTS instruction that was already delivered into the current
conversation history. If a user needs a completely clean context after switching
modes, `/clear` or a new session is the clean boundary.

This is preferable to adding context-surgery or nested cache machinery just for
the setting.

## File changes

### 1. `src/utils/instructionFiles.ts`

Add the mode resolver and targeted user-settings updater.

Expected size: roughly 80-120 lines plus tests.

### 2. `src/utils/claudemd.ts`

Add small helpers for:

- eligible root-to-CWD directories;
- CLAUDE-claim detection;
- AGENTS candidate loading;
- mode gates.

Wire those helpers into:

- eager project discovery;
- nested directory discovery;
- conditional project-rule discovery;
- additional-directory gating for managed-only.

Also add the resolved-symlink re-check in `processMemoryFile()`.

Avoid a broad refactor. Keep the existing `claude-md` path structurally close to
today's code.

### 3. `src/components/Settings/Config.tsx`

Add the row/picker, write path, read-only override behavior, revert handling, and
`clearMemoryFileCaches()` call.

Use an existing picker pattern if possible. Do not create a settings subsystem for
one enum.

### 4. External include copy

Update `src/components/ClaudeMdExternalIncludesDialog.tsx` and the related
Config label so user-facing text says **project instruction file** rather than
only `CLAUDE.md`.

Keep existing persisted field names and analytics names.

### 5. Settings schema wording

Update the `claudeMdExcludes` description in
`src/utils/settings/types.ts` to say it can exclude CLAUDE or AGENTS project
instruction files.

Do not change the plugin-config object schema in this patch.

### 6. Docs

Update only the maintained instruction/config docs that would otherwise become
wrong:

- `docs/prompts/2026-04-30-prompt-surfaces.md`
- `docs/maps/prompt-system.md`
- `docs/maps/config-persistence.md`

## Focused test plan

Keep the regression set compact and behavior-oriented.

### Resolver

1. unset -> `claude-md-or-agents-md`;
2. each valid mode resolves;
3. disabled user settings ignores a stored user value;
4. flag overrides user;
5. policy overrides flag;
6. invalid winning value -> default;
7. targeted user update preserves sibling plugin/options/MCP data.

### Discovery

1. AGENTS only -> AGENTS loads by default;
2. root CLAUDE + AGENTS -> CLAUDE only by default;
3. each Cat Code CLAUDE name suppresses root fallback;
4. disabled `localSettings` means `CLAUDE.local.md` does not suppress fallback;
5. root CLAUDE + child AGENTS + nested Read -> child AGENTS does not load;
6. fallback project + nested CLAUDE + AGENTS -> nested CLAUDE wins in that directory;
7. both mode -> CLAUDE and AGENTS load in the pinned order;
8. claude-only -> current behavior, no AGENTS;
9. managed-only -> managed/recalled memory only, including no `--add-dir` project instructions;
10. AGENTS symlink to already-loaded CLAUDE -> one instruction;
11. `claudeMdExcludes` can exclude AGENTS;
12. nested worktree eligibility uses the worktree's eligible files, not skipped main-repo files.

### Config UI

1. default label;
2. selecting each mode writes the expected value;
3. flag/policy-owned mode is read-only;
4. Escape restores the original user option.

Do not add exhaustive tests for intentionally deferred behavior.

## Verification

Run focused checks first:

```sh
bun test src/utils/instructionFiles.test.ts
bun test src/utils/claudemd.test.ts src/utils/claudemd.discovery.test.ts
bun test src/components/Settings/
```

Then:

```sh
bun run build:dev:full
```

For documentation-only edits:

```sh
git diff --check
bun run maps:lint
```

## Acceptance criteria

The v1 feature is done when:

1. A project with no Cat Code CLAUDE claim automatically uses AGENTS.
2. A project with a root-to-CWD Cat Code CLAUDE claim does not use AGENTS,
   including nested AGENTS.
3. A fallback project can use nested AGENTS, with a nested CLAUDE file claiming
   its own directory.
4. `/config` exposes the four Project instructions choices using the
   upstream-compatible storage path.
5. `managed-only` cannot leak project/user instructions through normal,
   nested, conditional-rule, or `--add-dir` paths.
6. AGENTS uses Cat Code's existing project-instruction parser/framing and exclude
   behavior.
7. A symlink alias cannot inject the same CLAUDE/AGENTS instruction twice.
8. Changing the setting affects future discovery without requiring a process
   restart; a clean historical context after a mode switch uses `/clear` or a
   new session.
9. Existing CLAUDE-only behavior remains covered by regression tests.
10. No provider-specific or plugin-hook architecture is added.
