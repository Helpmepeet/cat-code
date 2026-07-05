# GUI Verification Process

This process is for agent-driven GUI rows after P3-H. The harness helps locate
and cross-check state; it does not replace observing the live app.

## Dev Harness Launch

Run the desktop app in dev with the harness flags:

```bash
CATCODE_TEST_CWD_ALLOWLIST=/path/one:/path/two \
CATCODE_INITIAL_CWD=/path/one \
CATCODE_DEBUG_STATE=1 \
bun run --cwd app dev
```

- `CATCODE_TEST_CWD_ALLOWLIST` is main-read only. While set, `pickDirectory()`
  never opens the native picker; it returns one-time cwd tokens for the
  allowlisted realpaths in cyclic order.
- `CATCODE_INITIAL_CWD` creates the primary startup session at that validated
  cwd. If invalid, the app starts with an empty shell rather than a wrong-cwd
  fallback.
- `CATCODE_DEBUG_STATE=1` writes the debug export only in dev builds.

Readiness is the stdout line:

```text
[main] renderer ready
```

That line only means the window and renderer bridge are up. For assertions about
session state, poll the export predicate instead: parse the export and wait until
it shows the expected row, status, cwd, tab, sidebar row, or permission prompt.

## Debug Export

Path:

```text
<claude-config-home>/desktop/debug/state.json
```

The file is written by Electron main with mode `0600`; the containing debug
directory is `0700`.

Schema version `debugStateVersion: 1`:

```json
{
  "debugStateVersion": 1,
  "writtenAt": 1751700000000,
  "rendererStateAt": 1751699999750,
  "sessions": [],
  "renderer": {
    "activeSessionId": null,
    "tabs": [],
    "sidebar": [],
    "permissions": {}
  }
}
```

Use `rendererStateAt` as the freshness signal for renderer-owned fields. If the
renderer crashes, `sessions` can keep changing while the renderer half is stale.

## Honesty Rules

1. **The debug export may LOCATE and CROSS-CHECK, never substitute.** Every 🖐 acceptance claim must still cite an AX-observed label from the live window. Otherwise GUI rows stop testing rendering (reverse-Potemkin).
2. **P3-8 (the gate) must include at least ONE real picker interaction** so the bypass never hides a regression in the production create path.
3. **Standing convention for new surfaces (P3-6/P3-7/Phase-4 prompts):** every status-bearing element carries an aria-label with session identity + state, e.g. `"session catcode-gui-scratch — crashed, restorable"`. New UI ships agent-verifiable by construction; no retrofits.
4. **Cheap doc fix, no code:** note in the GUI-test docs that `registry.json` already maps appSessionId ↔ enginePid/cwd/socketPath for kill-the-right-sidecar forensics.
