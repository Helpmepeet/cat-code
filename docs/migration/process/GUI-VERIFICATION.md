# GUI Verification Process

This process is for agent-driven GUI rows after P3-H. The harness helps locate
and cross-check state; it does not replace observing the live app.

The dev desktop app presents as **Cat Code Dev** in the window title and AX app
discovery. GUI-driving agents should use that string to find the right window.

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

## For The Driving Agent

If a separate Codex/macOS GUI verifier is spawned, paste this section into its
prompt along with the scenario-specific steps:

- Locate the app by the AX/window title **Cat Code Dev**. With `cua-driver`, use
  app listing/discovery first, then drive that app's AX tree.
- Use this doc as the verification plan: launch with the harness flags when
  allowed, wait for `[main] renderer ready`, and poll the debug export for state
  predicates.
- The export is only a locator and cross-check. Every GUI acceptance claim must
  also cite a live AX-observed label or title from the app window.
- For P3-8 and any production-create-path check, exercise the real native picker
  at least once; do not rely only on `CATCODE_TEST_CWD_ALLOWLIST`.

## Debug Export

`<claude-config-home>` resolves to `CLAUDE_CONFIG_DIR` when that environment
variable is set, otherwise `~/.cat-code` (the app normalizes the path to NFC).

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

Each `sessions[]` row is the host session descriptor plus dev-only advisory
fields:

- `appSessionId`: app-owned UUID used by tabs, sidebar rows, host API calls, and
  debug predicates.
- `engineSessionId`: engine transcript/session id, `null` until the ready frame
  bridges it.
- `cwd`, `title`, `status`, `restorable`, `createdAt`, `lastAttachedAt`: the same
  renderer-facing session descriptor fields used by the shell.
- `enginePid`: current sidecar process id when live. Use it for PID correlation,
  but treat it as advisory because it is rewritten on spawn/restart.
- `socketPath`: current Unix socket path when live; also advisory.
- `shutdown`: registry shutdown marker, `"clean"`, `"crashed"`, or `null`
  (`null` means the row is currently live or was live when the host last wrote).

## Registry Forensics

The durable registry is:

```text
<claude-config-home>/desktop/registry.json
```

It already maps `appSessionId` to `engineSessionId`, `cwd`, `shutdown`,
`enginePid`, and `socketPath`. Use it for kill-the-right-sidecar and
anti-Potemkin forensics: correlate the debug export's `appSessionId` with the
registry row, then compare `enginePid` before/after restore or crash-sweep. The
runtime fields (`enginePid`, `socketPath`) are advisory and must be checked
against live processes/files before acting on them.

## Honesty Rules

1. **The debug export may LOCATE and CROSS-CHECK, never substitute.** Every 🖐 acceptance claim must still cite an AX-observed label from the live window. Otherwise GUI rows stop testing rendering (reverse-Potemkin).
2. **P3-8 (the gate) must include at least ONE real picker interaction** so the bypass never hides a regression in the production create path.
3. **Standing convention for new surfaces (P3-6/P3-7/Phase-4 prompts):** every status-bearing element carries an aria-label with session identity + state, e.g. `"session catcode-gui-scratch — crashed, restorable"`. New UI ships agent-verifiable by construction; no retrofits.
4. **Use the registry for PID forensics.** `registry.json` already maps appSessionId ↔ enginePid/cwd/socketPath; use that map to kill or inspect the intended sidecar, and record the registry/debug-export evidence in the GUI report.
