# Anthropic restoration — review fixes and live verification

**Date:** 2026-07-27
**Scope:** fixes for F1–F7 from
`2026-07-27-anthropic-restoration-review-impl-review.md`, plus two live-only
request blockers discovered while verifying the rebuilt CLI.
**Verdict:** **HEADLESS GREEN; live Anthropic CLI GREEN; desktop GUI acceptance
still pending.**

## Review findings closed

1. Managed-organization policy now validates every newly issued terminal
   Anthropic token before any credential installation.
2. First-run provider activation is derived from initialized sidecar-owned
   account and route state. The renderer no longer sends activation authority,
   and the strict protocol rejects the removed field.
3. The current implementation scope includes the neutral Anthropic snapshot
   fixture and the renderer helper refactors needed for a self-contained
   typecheck.
4. Claude subscription identity follows the same effective
   `isClaudeAISubscriber()` decision as request authentication, so an external
   API key does not display a retained OAuth account as active.
5. A second login is rejected while credential persistence is already running;
   the first commit cannot be silently superseded.
6. Invalid Anthropic manual callback input is validated without consuming the
   retry resolver. A corrected callback can be submitted in the same attempt.
7. Model/provider changes share one effort reconciliation helper across desktop,
   `/model`, and `/switch-account`.

Both independent `review-impl` reviewers rechecked their original findings
against the fixed working tree and returned **GREEN** with no remaining
actionable finding in F1–F7.

## Additional live-only blockers closed

The first post-fix Haiku probe found that startup selected provider-sensitive
tools before resolving an explicit Claude model. That exposed OpenAI's
`Apply_patch` custom schema to Anthropic and the API rejected the request.
Startup now resolves the session provider before `getTools()`, so Claude gets
the normal `Edit` object schema and GPT keeps `Apply_patch`.

The next probe reached Anthropic and exposed an invalid global prompt-cache
ordering: tools render before system blocks, so a globally scoped `system[0]`
was not a true prefix. Tool-bearing requests now keep system caching at org
scope. Built-in, extra, and advisor tool definitions are all covered.

A final independent read-only spot-check returned **GREEN** for both live-only
fixes and found no remaining actionable defect.

## Verification evidence

- `bun test app/` — **1,647 pass / 0 fail** across 138 files.
- `bun run --cwd app typecheck` — clean.
- `bun run --cwd app typecheck:sidecar` — scoped pass; 5,546 upstream
  diagnostics ignored, 0 owned.
- `bun run --cwd app renderer:build` — success; 605 modules.
- Focused engine regressions — managed-org commit gate, `/model`,
  `/switch-account`, effort reconciliation, provider tool selection, and
  Anthropic cache ordering all pass file-isolated.
- `bun run build:dev:full` — success; workspace-map lint passes with the same
  eight existing recommendations and the full dev CLI is built.
- Live rebuilt CLI — `claude-haiku-4-5-20251001` initialized with `Edit` and no
  `Apply_patch`, authenticated through the logged-in Anthropic subscription,
  and returned exactly `ANTHROPIC_OK` in one successful turn with zero
  permission denials.
- `git diff --check` — clean.

## Remaining gate

`bun run --cwd app test:hardening` and operator-driven Electron checks were not
run because they launch the GUI and this fix turn did not authorize an app
launch. Provider cards, Accounts interactions, model/effort/Fast controls,
resume behavior, and a real desktop next turn therefore remain operator-GUI
acceptance items. The known cross-process pool invalidation, session-scoped
OAuth progress correlation, and third-party resume environment dependencies
remain broader follow-ups.
