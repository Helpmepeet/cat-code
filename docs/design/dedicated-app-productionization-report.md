# Dedicated App Productionization Report

## Summary

This task prepared the Cat Code workspace for Claude Design to production dedicated-app migration.

It did not perform visual productionization because the Claude Design export is not present yet.

It did not connect real runtime behavior.

It did not create a new root `web/` app.

## Claude Design export status

Claude Design export is not present yet.

When exported, place source files under:

```txt
docs/design/claude-design/
```

Expected files:

* exported HTML
* screenshots
* handoff bundle
* original prompts
* design notes
* generated assets

## Files created

* `docs/design/claude-design/README.md`
* `docs/design/claude-design/export-placeholder.md`
* `docs/design/dedicated-app-design-contract.md`
* `docs/design/dedicated-app-component-inventory.md`
* `docs/design/dedicated-app-productionization-plan.md`
* `docs/design/dedicated-app-api-contract.md`
* `docs/design/dedicated-app-productionization-report.md`

## Existing repo facts used

The dedicated app migration target is:

* `src/dedicated-app/` for shell and presentation
* `src/app-runtime/` for shared app-facing runtime state/contracts

Root `web/` is stale for this dedicated-app migration path unless used only as historical reference.

The current dedicated app is placeholder/scaffold work.

Placeholder state should remain honest and should not claim real runtime integration.

## Code changes

No source code changes are required for this preparation task.

If source code was changed, document it here.

## Validation

For docs-only changes, run:

```bash
git diff --check
```

If source files under `src/app-runtime/` or `src/dedicated-app/` were changed, also run:

```bash
bun run validate:dedicated-app
bun run build:dedicated-app
```

## Next recommended task

After Claude Design files are exported:

1. Read files under `docs/design/claude-design/`
2. Update `docs/design/dedicated-app-design-contract.md`
3. Extract real visual tokens
4. Map Claude Design screens to `dedicated-app-component-inventory.md`
5. Productionize `src/dedicated-app/` visually using current placeholder state
6. Keep `src/app-runtime/` and `src/dedicated-app/` boundary intact
7. Keep validation passing

## Non-goals completed

This task intentionally did not:

* create a new root `web/` app
* modify terminal UI
* connect real QueryEngine sessions
* connect real permission events
* add dependencies
* perform a broad refactor
* claim runtime capability that does not exist yet
