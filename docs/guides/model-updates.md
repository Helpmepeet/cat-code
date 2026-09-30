# Model Update Guide

Use this checklist when adding a model, changing its ID or default, or replacing
and retiring a model. Model IDs connect the picker, provider routing, prompts,
capability decisions, settings, and session replay. Update those owners together
and verify behavior from the source.

## 1. Define the change

Before editing, confirm from the provider's authoritative model documentation:

- Cat Code's canonical ID and each provider-facing ID. Do not assume provider
  IDs are interchangeable.
- Display name, picker label, and whether this is an additional choice or a
  direct replacement.
- Supported reasoning efforts, context and output limits, and any tool or
  modality constraints that affect routing.
- Default-selection policy: provider, subscription, environment, session, or
  account-switch behavior may choose different models.
- Prompt family and any model-specific request translation.

For a direct replacement, keep one active picker choice and make the new model
the default where intended. This is a single-user app; do not add rollout flags,
compatibility UI, or duplicate old and new choices unless the product request
specifically calls for them.

## 2. Update the runtime owners

Start with the [query/provider map](../maps/query-provider-runtime.md) and, for
Codex models, the [Codex core map](../maps/codex-core.md). Check each applicable
owner below; search for the old and new IDs to find additional consumers.

| Concern | Main owners |
|---|---|
| Provider IDs and model catalog | [`src/utils/model/configs.ts`](../../src/utils/model/configs.ts), [`src/services/api/codex-fetch-adapter.ts`](../../src/services/api/codex-fetch-adapter.ts) |
| Defaults, parsing, canonicalization, display names | [`src/utils/model/model.ts`](../../src/utils/model/model.ts), [`src/utils/model/modelStrings.ts`](../../src/utils/model/modelStrings.ts), [`src/utils/model/aliases.ts`](../../src/utils/model/aliases.ts) |
| Picker and agent choices | [`src/utils/model/modelOptions.ts`](../../src/utils/model/modelOptions.ts), [`src/utils/model/agent.ts`](../../src/utils/model/agent.ts) |
| Context and reasoning capabilities | [`src/utils/context.ts`](../../src/utils/context.ts), [`src/utils/effort.ts`](../../src/utils/effort.ts), [`src/utils/model/modelCapabilities.ts`](../../src/utils/model/modelCapabilities.ts) |
| Prompt family and provider request mapping | [`src/constants/promptStyle.ts`](../../src/constants/promptStyle.ts), [`src/services/api/codex-fetch-adapter.ts`](../../src/services/api/codex-fetch-adapter.ts) |
| Secondary and derived routing | Search `src/` and `app/` for default, fast, agent, classifier, Opus-compatibility, and account-switch model choices. |

Keep canonical IDs, display strings, config keys, picker values, provider IDs,
and capability declarations consistent. Check reasoning conversion at the API
boundary (including how Cat Code's `minimal` effort is represented), and verify
context calculations use the model's actual advertised context. Check both the
normal session default and any startup, run-control, or account-switch path that
has its own default selection.

## 3. Retire or replace an ID safely

Treat a retired ID as migration input, not an active model. For a replacement:

1. Add the successor to active catalogs and routing before removing the old ID.
2. Add the old-to-new mapping to the existing family-specific remapper and
   extend its existing settings migration. Use the existing startup registration
   in [`src/migrations/runEngineMigrations.ts`](../../src/migrations/runEngineMigrations.ts);
   do not create another migration framework.
3. Cover saved selectors handled by
   [`src/migrations/migrateRetiredModels.ts`](../../src/migrations/migrateRetiredModels.ts):
   selected model, `availableModels`, `modelOverrides` keys, and the in-process
   main-loop override. Preserve a successor override if one already exists,
   remove duplicate allowlist entries, and verify a second migration run is a
   no-op. Respect the current ownership boundary: this helper rewrites
   user-owned settings, while explicit legacy selections from other sources
   remain readable through runtime remapping.
4. Keep the old ID out of the active catalog, picker, provider model list,
   defaults, capability tables, and routing targets. Retain old-ID recognition
   only where needed for migration, old settings/session replay, or historical
   display.
5. Do not rewrite transcript history just to make old model names display as
   current. Keep replay behavior and current selectable-model behavior distinct.

Use an ID search as an audit, not a blind replacement:

```sh
rg -n 'old-model-id|new-model-id' src app
```

Classify each old-ID hit. Runtime use in an active catalog or routing branch
usually indicates incomplete retirement; hits in remappers, migration tests,
historical display, and replay support may be intentional.

## 4. Test the contract

Add or update behavior tests at the owners affected by the change. At minimum,
cover:

- The intended default and exactly one picker entry for the successor.
- No picker, catalog, or active provider-list entry for a retired ID.
- Old-ID canonicalization and migration, including collisions with an existing
  successor, allowlist deduplication, and idempotency.
- Provider request ID, compatibility routing, reasoning conversion, context
  size, supported efforts, and prompt-family selection.
- Any distinct desktop/run-control or secondary-model default path.
- A setting written after migration cannot select or persist the retired ID.

Useful starting suites include
[`src/utils/model/gptModelCatalog.test.ts`](../../src/utils/model/gptModelCatalog.test.ts),
[`src/services/api/codex-fetch-adapter.test.ts`](../../src/services/api/codex-fetch-adapter.test.ts),
[`src/migrations/migrateRetiredGptModels.test.ts`](../../src/migrations/migrateRetiredGptModels.test.ts),
and [`app/sidecar/runControlsDomain.test.ts`](../../app/sidecar/runControlsDomain.test.ts).
Route from the changed behavior to the focused suites in the two maps above,
then run `bun run build:dev:full` for source/runtime changes. For documentation-
only edits, run `git diff --check`, `bun run maps:lint`, and check changed links.

## 5. Update documentation

When model ownership or routing changes, update the affected provider maps and
their refresh dates. Keep this guide process-oriented; do not copy the full model
catalog into it. Record which model is current/default and which ID is retired
in the relevant map. The maps route to source; source remains authoritative.
