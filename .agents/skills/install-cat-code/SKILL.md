---
name: install-cat-code
description: Installs or updates Cat Code.app from a matching GitHub-verified build when the user asks to install the latest update, or on $install-cat-code. Also handles explicitly requested local builds and build-only work. Not for explaining updates, ordinary code edits, development launches, the CLI updater, or the Codex app.
---

# Build and install Cat Code

Use this only for an explicit build or installation request in the Cat Code repository. Updating this skill or asking how installation works does not authorize an installation. Read the current `CLAUDE.md`, `docs/migration/decisions/LOCAL-USE-CONTRACT.md` including its GitHub delivery amendment, `.github/workflows/{ci,delivery}.yml`, `app/scripts/package-app.ts`, and `app/scripts/install-local-app.sh` before acting; source and current repository instructions take precedence over this skill.

## Select the source

Inspect the branch, `HEAD`, working tree, origin repository, and existing `/Applications/Cat Code.app`. Identify which changes the user wants in the app. A shared checkout can contain another session's edits: do not include them accidentally, stash them, or clean them.

For an ordinary install/update request, prefer the matching verified GitHub delivery below. An explicit request to build locally or build without installing uses the local-build path instead. If the user requested particular changes, a successful older build that lacks them is not a substitute. For "latest verified build", select the newest eligible delivered version, but disclose newer local or remote changes that it excludes.

If the matching CI or delivery run is pending or failed, or its artifact is missing, expired, or inaccessible, report that condition. Do not silently install an older version, rebuild locally, push changes, or rerun GitHub workflows. Offer waiting, investigating the failure, or an explicitly authorized local build; preserve any build route the user already requested.

Building, installing, pushing, and launching are distinct actions. An explicit request to build and install authorizes that run's build and replacement steps; a build-only request does not authorize installation. Push only when separately requested. For a requested push, fetch the current remote, inspect divergence, verify the destination and signed-in account, and use a normal non-force push. Do not publish another session's uncommitted work.

## Download and verify the GitHub build

1. Use the authenticated `gh` CLI for the repository identified by origin. Read current workflow definitions rather than trusting a remembered run, URL, or artifact name.
2. Identify the full 40-character source SHA and successful `CI` and `Desktop delivery` runs for that source. Require same-repository `main` delivery from an eligible push/manual CI run, not a pull-request artifact. Confirm the packaged source through the delivery summary, artifact identity, and bundle verification; a `workflow_run` workflow's own head SHA is not by itself proof of the packaged source. Success for a different source SHA is insufficient.
3. Select the unexpired artifact belonging to that successful delivery run. With the current workflow its name is `cat-code-macos-arm64-FULL_SHA`. Download only that artifact to a fresh temporary directory with `gh run download DELIVERY_RUN_ID --repo OWNER/REPO --name ARTIFACT_NAME --dir DOWNLOAD_DIR`. Do not extract into the shared checkout or `/Applications`.
4. The artifact contains an inner app ZIP and its `.sha256` file. Verify the inner archive with its SHA-256 file before extracting it into isolated staging. A mismatch stops installation; do not regenerate the checksum, re-sign, or rebuild to make it pass.
5. Verify the extracted bundle's deep strict code signature, `com.catcode.desktop` identifier, arm64 executable, and full source SHA inside the sealed ASAR. The archive name alone does not prove its contents. Keep the bundle intact, including its compiled sidecar and companion resources.
6. Prepare a clean temporary checkout of the selected SHA with its own frozen root/app dependencies. Place the verified downloaded bundle at that checkout's `app/dist-app/Cat Code.app`, the path the current packaged smoke script reads. Run `bun run --cwd app smoke:packaged:headless` there against the downloaded bundle. Do not run `package` first: that would replace the download with a different artifact.
7. Install that exact verified bundle using the maintained `install:local --bundle ... --commit FULL_SHA --no-launch` path below, from the prepared checkout. Do not use the default installer command for this route: it rebuilds committed `HEAD`.

GitHub's archive retention is finite; check the artifact's actual expiry. This is an ad-hoc-signed personal build, not Developer ID signed or notarized. Signature and smoke checks do not establish Gatekeeper acceptance, GUI behavior, or live-account behavior. Report a first downloaded build's remaining target-Mac checks, and do not remove quarantine, disable Gatekeeper, or bypass a security refusal to force it open.

## Build locally when requested

Prefer a clean committed snapshot of the intended ref in a temporary clone when the checkout has unrelated changes. Install dependencies inside the selected clean checkout with `bun install --frozen-lockfile` at the root and in `app/`; do not link either `node_modules` directory from the shared checkout. The default installer does this automatically for committed `HEAD`. A lockfile mismatch must fail the build rather than update the lockfiles. Confirm the build prints the intended commit without a dirty suffix.

For committed `HEAD` installation, the installer performs this build-and-verify section; do not build twice. For a build-only request or to prepare a selected artifact, run `bun run --cwd app package` from the selected clean source. Verify the produced `app/dist-app/Cat Code.app` with `codesign --verify --deep --strict`, its `com.catcode.desktop` bundle ID, executable, and embedded build SHA. Run `bun run --cwd app smoke:packaged:headless`, which checks the bundled sidecar and ripgrep with scratch state. Routine installation does not need the GUI smoke or a UI inspection. Use those only when the user requests GUI verification or when diagnosing an observed launch failure. Use package and smoke evidence for the exact artifact and commit being installed. Do not use the user's live profile as a smoke-test substitute.

## Install when requested

Check whether `/Applications/Cat Code.app` is running. Do not stop a process you did not start. If the app is running, report that it must be quit before installation and wait for it to close. Use the maintained installer for every replacement; do not recreate its copy/move commands manually:

- To build committed `HEAD` and install without opening the app, run `bun run --cwd app install:local --no-launch`.
- Omit `--no-launch` only when the user authorized reopening the app.
- For the downloaded verified bundle, or a bundle already packaged and headless-smoke-tested from the selected clean source, run `bun run --cwd app install:local --bundle "/absolute/path/Cat Code.app" --commit FULL_SHA --no-launch` from the prepared checkout. This avoids rebuilding a different checkout. Omit `--no-launch` only with launch authorization.

The install is complete only when `/Applications/Cat Code.app` is the sole visible production Cat Code app in `/Applications`, its signature and embedded SHA match the selected build, and the final app is registered with Launch Services. Development bundles have a separate identity and are outside this cleanup. The installer stages under `/Applications/.cat-code-install.noindex/` and retains one previous build in `~/Library/Application Support/Cat Code Install Backups.noindex/`; it retires older identified inactive installer backups only after the replacement verifies and registers. Never create visible `.staging-*.app` or `.rollback-*.app` siblings in `/Applications`.

On failure, preserve recovery artifacts and report the actual installed/rollback state. An interrupted-install lock or extra visible production app requires inspection; do not bypass the lock or sweep another session's artifacts. Do not report success while duplicate-app or registration checks fail. Launcher caches can refresh later, so distinguish filesystem/registration checks from an observed launcher UI.

Report the selected route (GitHub download or local build), installed path and SHA, CI/delivery run links when used, checksum/signature/headless smoke results, retained rollback path, and whether the app was launched or observed running. Leave unrelated working-tree edits untouched.
