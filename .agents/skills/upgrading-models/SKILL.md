---
name: upgrading-models
description: Adds, upgrades, replaces, or retires AI models in the Cat Code codebase, including model IDs, picker entries, provider routing, capabilities, defaults, and saved-selection migrations. Use when asked to support a newly released model, replace an old model with its successor, remove a retired model, or change the application's model defaults. Not for choosing which model to use, switching one session's model, comparing benchmarks or prices without a code change, account setup, upgrading the Cat Code app, or unrelated applications' model integrations.
---

# Upgrade Cat Code models

Make the requested model change without turning a catalog update into a wider project. This skill authorizes no live API probes, account operations, app installation, GUI actions, pushes, or independent review agents. Follow the current repository instructions for permissions, shared-tree ownership, commits, and required validation.

## 1. Frame the change

State briefly whether the task adds a model, replaces/retires one, or changes a default. Preserve the user's requested scope: replacing one tier does not imply changing the main model, replacing other tiers, or upgrading the installed app. Proceed with routine, reversible work; ask only when a missing decision or specification would materially change correctness or authorization.

Use these observed failure cases as constraints:
- Repeated serial discovery delayed a replacement, and active test fixtures were found late.
- A replacement expanded into pricing and retained-usage indexing without making that added scope explicit.
- Broad test runs were repeated, and a feature-gated test was first invoked without its required feature.

## 2. Route once, verify specifications once

Read the current repository instructions, `docs/maps/WORKSPACE_MAP.md`, and `docs/guides/model-updates.md` when available. Reuse current contents already read in this session. The guide owns the model-update checklist; do not duplicate it in another plan or report. Follow only the focused maps relevant to this change. If local docs are absent, route from source and package scripts instead of claiming they were checked.

Confirm the provider-facing ID, supported reasoning levels, context/output limits, and applicable request/prompt behavior from authoritative provider documentation. Check prices only when pricing is in scope. Distinguish the provider's advertised limits from Cat Code's effective input budget. Do not infer capabilities from a version number or inherit the predecessor's unsupported effort settings. If a needed specification cannot be verified, identify the gap rather than inventing a value.

## 3. Trace the contract, then patch coherently

Search the old/new IDs, display names, config symbols, and aliases across relevant code, tests, documentation, and configuration. Group the results into active consumers, compatibility/migration, and historical display/fixtures. Inspect each affected owner before editing. Include active test expectations in this first pass instead of discovering every stale expectation through a full-suite failure.

Use the guide to cover applicable catalog, picker, agent/tool schema, routing/default, capability, prompt-family, and saved-selection owners. Trace derived routes such as secondary calls, classifier fallback ladders, image requests, startup, and desktop controls when they consume the changed contract. Update generated contracts through their generators when affected. Check build/runtime feature wiring only if the change introduces or changes a feature, not merely because a model ID changed.

For a replacement, keep one active successor choice, route legacy selections through the existing remapper, and extend the existing startup migration/version when persisted state needs rewriting. Preserve successor overrides, deduplicate allowlists, and keep a second migration run a no-op. Keep historical identity separate from current selection: old transcript labels, cost history, and replay fixtures are not stale just because they name the predecessor. Do not blindly replace every old-ID match or rewrite third-party provider IDs without evidence.

Update existing pricing metadata if requested or already part of the affected contract. If pricing requires new billing or analytics machinery, make that scope explicit rather than silently adding a subsystem. Do not bundle unrelated cleanup or fix another session's slice. Delegate only an independent, bounded implementation slice that saves work; do not investigate the same slice alongside its worker.

## 4. Validate in dependency order

Keep a short in-memory checklist, not a new plan file:
- [ ] Required IDs, capabilities, and intended defaults verified.
- [ ] Active consumers and affected tests updated; historical matches classified.
- [ ] Replacement migration covers legacy pins, collisions, deduplication, and idempotence.
- [ ] Focused behavior checks pass with their required feature flags and isolated state.
- [ ] Applicable repository-required package checks run; limitations recorded.
- [ ] Final diff contains only intended work; documentation and commit follow repository policy.

Start with the lowest-layer tests for the changed behavior. Exercise request translation and receiving-boundary validation where affected, plus process-level startup/migration or desktop checks when that boundary matters. A regression test must distinguish the old behavior from the intended replacement, not merely repeat the new constant.

Read the test's invocation requirements before running it. Use isolated settings and credentials; offline fixtures are not permission for a live quota-consuming probe.

After focused checks pass, run the applicable package checks required by the current `CLAUDE.md`. Batch independent checks where useful, but avoid enough concurrent builds/process suites to create resource contention. A narrower discretionary check does not waive a required check.

When a check fails, understand the cause before editing. Distinguish a stale active fixture from a real routing/capability bug and an unrelated shared-tree failure. Correct only this task's defects, then rerun the affected checks. Do not rerun the entire matrix without a relevant change, failure, or unresolved concern. For documented root typecheck debt, establish whether this change adds diagnostics without reverting others' work. Report a failed broad run and any isolated rerun honestly; do not describe the full suite as green because its failed case later passed alone.

## 5. Finish with the result

Inspect the actual final diff, account for remaining predecessor references, and update relevant maintained docs when present. Follow the repository's commit policy and stage only intended paths. Report the active replacement/default, migration and historical-data behavior, verified capabilities, checks and material gaps, and whether anything was installed or exercised live. Do not turn an offline source change into a claim that the running app or provider accepted the new model.
