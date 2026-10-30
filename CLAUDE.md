# CLAUDE.md

Single-user Claude Code fork: terminal engine in `src/`, Electron app in `app/`.
Many agent sessions share this tree at once.

Start repository work with `docs/maps/WORKSPACE_MAP.md` when present; `docs/` is
local-only. For prompt work, also read `docs/prompts/2026-04-30-prompt-surfaces.md`.

## Commands (§3)

Run what covers the change.

```bash
bun run build:dev:full                 # engine build and lint gates
bun test <paths>
bun run --cwd app test
bun run --cwd app typecheck
bun run --cwd app typecheck:sidecar
bun run --cwd app renderer:build       # renderer build inputs changed
bun run --cwd app test:slow <group>    # groups in app/scripts/desktopTests.ts
bun run --cwd app test:all             # before packaging
git diff --check && bun run maps:lint  # docs-only changes
```

- Never run bare `bun test` (account suites need file isolation) or `bun test app/`
  (a substring filter that runs stale copies under `tmp/`).
- Root typecheck is already red: add no new diagnostics. Root lint reads only the
  branch diff and skips `app/`.
- `bun run build` and `./cli` need an explicit request. `cat-code exec` covers the
  Claude harness only.
- Sidecars load current code at spawn: while editing `src/` or `app/sidecar/`, do
  not spawn or wake sessions in an open dev app. Main and preload changes need a
  full dev restart.

## Architecture (§5)

Renderer → preload → main → supervisor → Unix socket → Bun sidecar running the real
engine. Unless a redesign is requested, preserve the socket transport, one engine
process per session, raw `AppSessionEvent` fidelity, and separate `appSessionId` /
`engineSessionId`.

- Security lives at the receiving boundary: closed inbound schemas, engine-owned
  permission requests, bounded frames. The renderer never gets raw credentials or
  authors permission rules.
- `app/shared/protocol.ts`: breaking wire shapes bump the version.
- Test engine integration through `src/app-runtime/`, not stubbed tools,
  permissions, or resume paths.
- Features need both the set in `scripts/build.ts` and `feature(...)` consumers.
- Regenerate, never hand-edit: `app/shared/*.snapshot.d.ts`,
  `src/entrypoints/sdk/coreTypes.generated.ts`.
- Raw logs, transcripts, settings, and debug output never enter product model prompts.

## Shared tree

- Unfamiliar edits and untracked files belong to another session. Re-read shared
  files before writing, and check ownership before calling a failure unrelated.
- Stage explicit paths and only your hunks. No stash, sweep-clean, `git add -A`,
  `git add -u`, or `git commit -a`.
- Commit verified work to the current branch without asking, as
  `type(scope): subject`. No branches, worktrees, or PRs unless requested.
- Push only when asked. No history rewrites.

## Live state

`~/.cat-code/`, the account vault, and the running app hold real work; tests use
isolated state. Get authorization for live logins, token refreshes, quota-consuming
probes, GUI launches or driving, and `test:hardening`. GUI work uses **Cat Code Dev**.

## Code

- Desktop state uses reducers and read-time selectors; never mutate transcript rows.
- Renderer styling belongs in stylesheets and classes, not inline `style={{}}`.
- A comment should need almost no maintenance. Keep rationale and incident context.

## User-visible text (§7)

No em dashes or engineering notes. Status and helper text must change what the user
does or how they read the data. `§7-ok` marks a justified exception to
`app/renderer/src/userVisibleText.test.ts`.
