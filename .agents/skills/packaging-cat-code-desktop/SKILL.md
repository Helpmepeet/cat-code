---
name: packaging-cat-code-desktop
description: "Packages and installs the local Cat Code macOS desktop app when the user asks to package the app, install the desktop app, build Cat Code.app, or invokes /packaging-cat-code-desktop. Uses the repository packaging workflow, validates the bundle, and safely replaces /Applications/Cat Code.app. Do NOT use for development launches, test-only builds, releases, notarization, distribution artifacts, or generic Bun troubleshooting."
disable-model-invocation: true
---

# Package and Install Cat Code Desktop

Use this only for an explicit request to package and install the local macOS app. It builds from the current checkout, including intentional uncommitted changes, and replaces the local application bundle. It does not launch, stop, sign for distribution, notarize, or publish the app.

## Run the installer

1. Confirm this is the Cat Code repository and macOS. Inspect the working tree and the existing `/Applications/Cat Code.app`; treat source edits as another session's work.
2. Do not stop a running Cat Code process. A bundle swap affects later launches only, so say that reopening is required.
3. Execute the bundled script from the repository root:

```sh
bash .agents/skills/packaging-cat-code-desktop/scripts/package-and-install.sh
```

The script locates Bun from `PATH` or `~/.bun/bin`, runs the canonical `app` package script, verifies the built bundle, retains a rollback copy during the install, verifies the installed bundle, and removes the rollback copy only after success.

## Failure handling

- Report the failed stage and its output. Do not retry unchanged commands that failed for an understood reason.
- If the package build or validation fails before replacement, the installed app is untouched.
- If installation validation fails, the script restores the prior app bundle. Verify restoration before reporting the failure.
- A successful local ad-hoc signature does not make the app notarized. Do not treat a Gatekeeper assessment as a package failure without a user request to support distribution.

## Report

State the installed path, whether packaging and signature validation passed, the dirty/clean build identity printed by the package script, and that no live GUI launch was observed. Mention that an already-running app must be quit and reopened.
