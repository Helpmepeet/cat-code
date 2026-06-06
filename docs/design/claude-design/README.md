# Claude Design Export Intake

This folder is for Claude Design source material for the Cat Code dedicated app.

The Claude Design export is not present yet.

When the design is exported, place the source files here.

Expected files may include:

- exported HTML
- screenshots of all major screens
- Claude Design handoff bundle
- original prompts
- design notes
- generated assets
- notes about what must stay visually close
- notes about what can change during productionization

## Important rule

This folder is source material only.

Do not treat exported Claude Design HTML as production code.

The production implementation target is:

- `src/dedicated-app/` for the dedicated app shell and presentation
- `src/app-runtime/` for app-facing runtime state and contracts

Do not create a new root `web/` app for this flow.

## Intended workflow

```txt
Claude Design export
  -> docs/design/claude-design/
  -> design contract update
  -> component inventory update
  -> token extraction
  -> productionized dedicated app shell
  -> later runtime integration
```

## Productionization principle

Claude Design gives the target experience.

Production code should preserve:

* layout intent
* visual mood
* important interactions
* component ideas
* user flow

Production code should rewrite:

* messy generated HTML
* duplicated CSS
* fake hardcoded state
* prototype-only interactions
* one-off visual values
* non-reusable component structure
