---
name: checking-cat-code-change-impact
description: "Use when finishing Cat Code code, behavior, skill, prompt, or configuration changes to check affected docs, registries, settings, permissions, telemetry, and related surfaces. Not for choosing test commands; use verifying-cat-code-changes."
---

# Checking Cat Code Change Impact

## Overview

Cat Code changes often affect surrounding project surfaces beyond the edited file. Before claiming completion, decide whether the change needs updates to logs, telemetry, docs, tests, registries, settings, permissions, feature gates, remote behavior, generated types, cache behavior, or user-facing discovery.

This is a decision checklist. Do not update everything automatically. Do not skip considering these surfaces either.

## Core Rule

After changing code, ask:

> What project surfaces did this change affect, and which follow-up updates are actually needed?

For each surface, answer:

- **No** — not affected.
- **Yes** — update it.
- **Maybe** — inspect the existing pattern before deciding.

If unsure, inspect nearby code and existing conventions before changing anything.

## Change Impact Checklist

### 1. Should this be recorded in `DONE.md`?

Ask:

- Is this a completed user-visible feature?
- Is this a behavior change the user would care about?
- Is this part of a planned phase or milestone?
- Would future agents benefit from knowing this work is complete?
- Is this more than an internal cleanup, tiny fix, or test-only change?

If yes or maybe:

- Consider `DONE.md`.
- **Ask the user before writing to `DONE.md`.**
- Keep the entry short and consistent with the existing format.

If no:

- Do not add a completion log.

### 2. Should this add telemetry, diagnostics, or runtime logging?

Ask:

- Does this introduce a new important user action?
- Does this affect auth, accounts, models, tools, permissions, agents, skills, routing, plugins, MCP, or remote sessions?
- Would failure be difficult to debug without telemetry or diagnostic logs?
- Is there an existing telemetry/logging pattern for similar behavior?
- Could logging expose sensitive data?

If yes or maybe:

- Inspect existing telemetry/logging patterns first.
- Reuse existing event naming and metadata patterns.
- Prefer state transitions and bounded enum-like values.
- Follow existing privacy patterns for redaction, hashing, truncation, or PII tagging.
- Do not log tokens, credentials, raw prompts, private file contents, full user messages, unredacted plugin names, or arbitrary file paths unless an existing safe pattern explicitly allows it.

If no:

- Do not add logs “just in case.”

### 3. Should docs, manuals, help text, or PR changelogs change?

Ask:

- Did user-facing behavior change?
- Did a command, tool, skill, setting, profile, flag, model, provider, plugin, MCP workflow, or UI flow change?
- Would a user expect this in `README.md`, `AGENTS.md`, `CLAUDE.md`, `docs/`, help output, or a manual?
- Did the change make existing docs wrong?
- If opening a PR, does the user-facing changelog section need an entry?

If yes:

- Update the smallest relevant existing doc.
- Prefer editing existing docs over creating new files.
- Search for stale references.

If no:

- Do not add docs for internal-only implementation details.

### 4. Should tests change?

Ask:

- Is there new behavior?
- Is there changed behavior?
- Is this a bug fix that could regress?
- Is this prompt/model behavior where exact text matters?
- Is this discovery, registry, cache, permission, settings, provider, account, plugin, MCP, or remote behavior?
- Is there an existing test file for this surface?

If yes:

- Add or update targeted tests.
- Prefer focused regression tests over broad snapshots.
- For prompt behavior, assert important exact text where practical.
- For registry/discovery behavior, test that the item is actually reachable.
- For settings changes, test validation and backward compatibility.
- For provider changes, test the affected provider path.

If no:

- Run the relevant existing tests before reporting completion.

### 5. Should registries or discovery paths change?

Ask this especially when adding or changing:

- Skills
- Slash commands
- Tools
- Agent types
- Settings
- Profiles/accounts behavior
- Plugin/MCP behavior
- Prompt surfaces
- Keybindings
- Tips/onboarding entries

Check whether the changed thing must be wired into a central registry or discovery path.

Common Cat Code examples:

- Bundled skills may need central registration.
- Slash commands may need command registry updates.
- Tools may need tool registry updates.
- Skill metadata may affect model or slash-command discovery.
- Prompt changes may need prompt assembly updates.
- Cache/reload behavior may need invalidation updates.
- New keybinding actions may need schema and default binding updates.
- User education changes may need tips/onboarding/help updates.

### 6. Should settings, schemas, migrations, or config watchers change?

Ask:

- Did this introduce or change a setting?
- Did this change global/project config shape?
- Did this change keybindings or settings JSON schema?
- Does the change need a migration from old config?
- Is the change backward-compatible?
- Will existing unknown fields be preserved?
- Does settings reload/watch behavior need to notice the change?

If yes:

- Follow settings backward-compatibility rules.
- New fields should usually be optional.
- Do not remove or rename existing settings without a compatibility path.
- Add validation/schema tests where relevant.
- Add migration only when existing user config needs transformation.
- Consider settings cache invalidation and file watcher behavior.

### 7. Should permissions, safety, or policy behavior change?

Ask:

- Did this affect tool permissions?
- Did this affect automatic behavior?
- Did this affect hooks, profiles, accounts, models, providers, plugins, or MCP servers?
- Could this make a risky action happen without confirmation?
- Did new skill/command metadata introduce properties not already considered safe?
- Does remote/mobile/bridge execution need to allow or block this behavior?

If yes:

- Inspect existing permission patterns.
- Update tests for permission behavior.
- Do not make risky actions automatic unless explicitly authorized.
- Review remote/bridge allowlists for new commands.
- Review skill safe-property behavior if skill command metadata changed.

### 8. Should prompt cache or performance behavior be considered?

Ask:

- Did this change system prompts, tool schemas, skill lists, command lists, model selection, betas, cache-control, or provider request body?
- Did this add dynamic content to tool prompts or system prompts?
- Could this bust the shared prompt cache across users or within a session?
- Does this change startup, REPL render, compact/autocompact, or subagent performance?

If yes:

- Keep dynamic prompt/tool-schema content stable when possible.
- Avoid adding large always-loaded text.
- Prefer lazy loading for large references.
- Check existing prompt cache break detection patterns.
- Add targeted tests for prompt/request assembly if behavior changed.

### 9. Should SDK, generated types, or external API surfaces change?

Ask:

- Did this change SDK message shapes?
- Did this change Zod schemas used as type sources?
- Did this change hook payloads, control messages, or app-runtime session events?
- Did this change public command/tool/permission types?
- Are generated files or committed generated types expected to change?

If yes:

- Update the schema source of truth first.
- Regenerate or update generated types if this repo expects committed output.
- Add tests for serialization/deserialization boundaries.
- Check bridge, remote, app-runtime, and SDK consumers.

### 10. Should plugin, MCP, deep-link, or marketplace behavior change?

Ask:

- Did this affect plugin loading, plugin telemetry, marketplace discovery, MCP server config, MCP auth, or MCP permissions?
- Did this affect managed settings or enterprise policy?
- Did this affect deep-link install/open behavior?
- Could names, marketplace IDs, server URLs, or user-defined plugin data leak into telemetry?

If yes:

- Check plugin/MCP schemas and validation.
- Check managed policy behavior.
- Check privacy-safe telemetry fields.
- Check install/update/uninstall flows if applicable.
- Check remote and local behavior if both exist.

### 11. Should account, auth, provider, or token behavior change?

Ask:

- Did this affect login/logout, account switching, delete-account, profiles, token refresh, vaults, provider selection, or usage limits?
- Does changing accounts require refreshing cached feature flags or provider state?
- Does the behavior differ for Codex, Claude, OAuth, API key, or subscription flows?
- Could the change expose account IDs, aliases, emails, tokens, or vault paths?

If yes:

- Check account/profile tests.
- Check token refresh and account pool behavior.
- Check feature flag refresh behavior after auth changes.
- Avoid logging secrets or raw account data unless existing safe patterns allow it.

### 12. Should UI, keyboard, tips, onboarding, or help discovery change?

Ask:

- Did this add a visible interaction?
- Did this add or change a keyboard shortcut?
- Did this add a new mode, panel, menu, command, or setup flow?
- Should help text, tips, onboarding, or command suggestions mention it?
- Does it behave correctly on different platforms or terminals?

If yes:

- Update keybinding schema/default bindings if needed.
- Update help/discovery text if users need to find it.
- Update tips/onboarding only if the behavior is important enough to teach proactively.
- Avoid noisy tips for minor features.

### 13. Should stale references be searched?

Before claiming completion, search for old names and stale behavior in:

- Code
- Imports
- Tests
- Docs
- Markdown
- YAML/config
- Prompt text
- Skill descriptions
- Slash command names
- Tool names
- Settings names
- Feature flags
- User-facing strings
- Examples
- Plans/manuals under `docs/`

This is required even when tests pass. Tests prove behavior; stale-reference search proves the repository does not still describe the old behavior.

## Skill-Specific Checks

When adding or changing a Cat Code skill:

- [ ] Skill folder/name matches intended invocation.
- [ ] `SKILL.md` frontmatter is valid.
- [ ] Description starts with “Use when...”.
- [ ] Description describes trigger conditions, not workflow.
- [ ] Keywords match what future agents would search for.
- [ ] Bundled skills are registered centrally if needed.
- [ ] Discovery or menu behavior is verified if affected.
- [ ] Skill safe-property/permission behavior is considered if metadata changed.
- [ ] Usage/history/telemetry impact is considered.
- [ ] Prompt cache impact is considered if the skill affects always-loaded listings.
- [ ] `DONE.md` is considered for completed user-visible skill work, but only written after asking.

## Quick Decision Table

| Surface | Ask this |
|---|---|
| `DONE.md` | Is this a completed visible milestone? |
| Telemetry/logging | Would this action or failure be hard to debug later? |
| Privacy | Could logs expose secrets, prompts, file paths, plugin names, account data, or user content? |
| Docs/help | Would a user look for this behavior? |
| Tests | Could this behavior regress? |
| Registries | Does discovery need central wiring? |
| Settings/schema | Did config shape or validation change? |
| Migrations | Do existing users need old config transformed? |
| Permissions | Could this grant, deny, or automate access? |
| Remote/bridge | Should this work from remote/mobile, or be blocked? |
| Feature gates | Does enabled/disabled behavior both work? |
| Provider paths | Does behavior differ by Claude/OpenAI/Codex/Bedrock/Vertex/Foundry? |
| Prompt cache | Did prompts, tool schemas, or dynamic request assembly change? |
| SDK/generated types | Did public serialized shapes change? |
| Plugin/MCP | Did policy, auth, validation, marketplace, or server behavior change? |
| Accounts/auth | Did login, profile, token, vault, or usage-limit behavior change? |
| UI/keybindings | Can users discover and operate the new behavior? |
| Stale references | Does the repo still mention the old name or behavior? |

## Common Misses

| Miss | Better behavior |
|---|---|
| “I added a skill, but forgot whether it needs a log.” | Consider `DONE.md`, telemetry, discovery, permission metadata, and prompt cache separately. |
| “I changed code, but docs still describe the old behavior.” | Search stale references before claiming completion. |
| “I added a command/tool, but forgot the registry.” | Check central discovery and registry paths. |
| “I added a local command, but remote/mobile behavior is undefined.” | Decide whether it belongs in remote or bridge allowlists. |
| “I changed settings, but forgot schema/backward compatibility.” | Check settings schema, optionality, migrations, and validation tests. |
| “I changed prompt behavior, but only tested TypeScript logic.” | Add prompt/request assembly checks where relevant. |
| “I added telemetry with too much detail.” | Follow existing privacy-safe logging patterns. |
| “I added dynamic tool prompt content.” | Consider prompt cache stability and tool schema cache behavior. |
| “I changed SDK schemas, but forgot generated types.” | Update schema source and generated/public type surfaces. |
| “I added a shortcut, but not the keybinding schema.” | Update keybinding actions/defaults/help as needed. |
| “Tests passed, so I said done.” | Also search stale references and report verification honestly. |

## Final Report Requirements

When reporting completion, include:

- What changed.
- Which impact surfaces were checked.
- Which follow-up updates were made.
- Which surfaces were considered but did not need changes.
- What verification ran.
- Whether stale-reference search was performed.
- Any checks that failed or were not run.

Do not claim completion if verification failed or stale-reference search was not performed.
