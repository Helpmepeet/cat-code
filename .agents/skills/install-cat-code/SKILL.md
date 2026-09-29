---
name: install-cat-code
description: Builds or installs the local Cat Code macOS desktop app when the user asks to build Cat Code.app, update the installed app, or invokes $install-cat-code. Use the repository's build and smoke workflows and protect other sessions' uncommitted work. Do not use for ordinary Cat Code code edits, development launches, the Cat Code CLI updater, or updates to the Codex app.
---

# Build and install Cat Code

Use this for the operator's local desktop bundle in the Cat Code repository. Read the current `CLAUDE.md`, `docs/migration/decisions/LOCAL-USE-CONTRACT.md` §§4–8, and `app/scripts/package-app.ts` before acting; source and current repository instructions take precedence over this skill.

## Select the source

Inspect the branch, `HEAD`, working tree, and existing `/Applications/Cat Code.app`. Identify which changes the user wants in the app. A shared checkout can contain another session's edits: do not include them accidentally, stash them, or clean them. Prefer a clean committed snapshot of the intended ref in a temporary clone when the checkout has unrelated changes. Reuse the checkout's dependencies only if the clone remains clean according to `git status`; local dependency links may need entries in the clone's `.git/info/exclude`. Confirm the build prints the intended commit without a dirty suffix.

Building, installing, pushing, and launching are distinct actions. An explicit request to build and install authorizes that run's build and replacement steps; a build-only request does not authorize installation. Push only when separately requested. For a requested push, fetch the current remote, inspect divergence, verify the destination and signed-in account, and use a normal non-force push. Do not publish another session's uncommitted work.

## Build and verify

From the selected clean source, run `bun run --cwd app package`. Verify the produced `app/dist-app/Cat Code.app` with `codesign --verify --deep --strict`, its `com.catcode.desktop` bundle ID, executable, and embedded build SHA. Run `bun run --cwd app smoke:packaged:headless`, which checks the bundled sidecar and ripgrep with scratch state. Routine installation does not need the GUI smoke or a UI inspection. Use those only when the user requests GUI verification or when diagnosing an observed launch failure. Do not use the user's live profile as a smoke-test substitute.

## Install when requested

Check whether `/Applications/Cat Code.app` is running. Do not stop a process you did not start. For committed `HEAD` when the user wants the app reopened, `bun run --cwd app install:local` performs the clean build, headless smoke, verified replacement, and launch. Otherwise, copy the verified bundle to a unique staging path in `/Applications` and verify that copy. Move the existing bundle to a unique rollback path, then move staging into `/Applications/Cat Code.app`. Verify the installed signature and embedded SHA. If installation fails after moving the old bundle, restore it and verify the restoration. Preserve the rollback copy unless the user asks to remove it. An already-running app needs to be reopened to use the new bundle.

Report the installed path and SHA, package and headless smoke results, the rollback path, and whether the app was launched or observed running. Leave unrelated working-tree edits untouched.
