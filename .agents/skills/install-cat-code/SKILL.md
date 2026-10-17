---
name: install-cat-code
description: Builds or installs the local Cat Code macOS desktop app when the user asks to build Cat Code.app, update the installed app, or invokes $install-cat-code. Use the repository's build and smoke workflows and protect other sessions' uncommitted work. Do not use for ordinary Cat Code code edits, development launches, the Cat Code CLI updater, or updates to the Codex app.
---

# Build and install Cat Code

Use this for the operator's local desktop bundle in the Cat Code repository. Read the current `CLAUDE.md`, `docs/migration/decisions/LOCAL-USE-CONTRACT.md` §§4–8, `app/scripts/package-app.ts`, and `app/scripts/install-local-app.sh` before acting; source and current repository instructions take precedence over this skill.

## Select the source

Inspect the branch, `HEAD`, working tree, and existing `/Applications/Cat Code.app`. Identify which changes the user wants in the app. A shared checkout can contain another session's edits: do not include them accidentally, stash them, or clean them. Prefer a clean committed snapshot of the intended ref in a temporary clone when the checkout has unrelated changes. Install dependencies inside the selected clean checkout with `bun install --frozen-lockfile` at the root and in `app/`; do not link either `node_modules` directory from the shared checkout. The installer does this automatically for committed `HEAD`. A lockfile mismatch must fail the build rather than update the lockfiles. Confirm the build prints the intended commit without a dirty suffix.

Building, installing, pushing, and launching are distinct actions. An explicit request to build and install authorizes that run's build and replacement steps; a build-only request does not authorize installation. Push only when separately requested. For a requested push, fetch the current remote, inspect divergence, verify the destination and signed-in account, and use a normal non-force push. Do not publish another session's uncommitted work.

## Build and verify

For committed `HEAD` installation, the installer performs this build-and-verify section; do not build twice. For a build-only request or to prepare a selected artifact, run `bun run --cwd app package` from the selected clean source. Verify the produced `app/dist-app/Cat Code.app` with `codesign --verify --deep --strict`, its `com.catcode.desktop` bundle ID, executable, and embedded build SHA. Run `bun run --cwd app smoke:packaged:headless`, which checks the bundled sidecar and ripgrep with scratch state. Routine installation does not need the GUI smoke or a UI inspection. Use those only when the user requests GUI verification or when diagnosing an observed launch failure. Use package and smoke evidence for the exact artifact and commit being installed. Do not use the user's live profile as a smoke-test substitute.

## Install when requested

Check whether `/Applications/Cat Code.app` is running. Do not stop a process you did not start. If the app is running, report that it must be quit before installation and wait for it to close. Use the maintained installer for every replacement; do not recreate its copy/move commands manually:

- To build committed `HEAD` and install without opening the app, run `bun run --cwd app install:local --no-launch`.
- Omit `--no-launch` only when the user authorized reopening the app.
- For a bundle already packaged and headless-smoke-tested from the selected clean source, run `bun run --cwd app install:local --bundle "/absolute/path/Cat Code.app" --commit FULL_SHA --no-launch`. This avoids rebuilding a different checkout. Omit `--no-launch` only with launch authorization.

The install is complete only when `/Applications/Cat Code.app` is the sole visible production Cat Code app in `/Applications`, its signature and embedded SHA match the selected build, and the final app is registered with Launch Services. Development bundles have a separate identity and are outside this cleanup. The installer stages under `/Applications/.cat-code-install.noindex/` and retains one previous build in `~/Library/Application Support/Cat Code Install Backups.noindex/`; it retires older identified inactive installer backups only after the replacement verifies and registers. Never create visible `.staging-*.app` or `.rollback-*.app` siblings in `/Applications`.

On failure, preserve recovery artifacts and report the actual installed/rollback state. An interrupted-install lock or extra visible production app requires inspection; do not bypass the lock or sweep another session's artifacts. Do not report success while duplicate-app or registration checks fail. Launcher caches can refresh later, so distinguish filesystem/registration checks from an observed launcher UI.

Report the installed path and SHA, package and headless smoke results, retained rollback path, and whether the app was launched or observed running. Leave unrelated working-tree edits untouched.
