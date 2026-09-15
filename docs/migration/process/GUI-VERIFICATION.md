# GUI Verification Process

This process is for agent-driven GUI rows after P3-H. The harness helps locate
and cross-check state; it does not replace observing the live app.

The dev desktop app presents as **Cat Code Dev** in AX app discovery and the
menu bar. GUI-driving agents should use that string to find the right window.
It is not painted anywhere on screen: since CC-77 the window has no title bar
(`titleBarStyle: 'hiddenInset'`), and the traffic lights sit in the app's own
tab bar.

## Dev Harness Launch

Run the desktop app in dev with the harness flags:

```bash
CATCODE_TEST_CWD_ALLOWLIST=/path/one:/path/two \
CATCODE_DEBUG_STATE=1 \
bun run --cwd app dev
```

- `CATCODE_TEST_CWD_ALLOWLIST` is main-read only. While set, `pickDirectory()`
  never opens the native picker; it returns one-time cwd tokens for the
  allowlisted realpaths in cyclic order.
- `CATCODE_DEBUG_STATE=1` writes the debug export only in dev builds.

The app launches with no engine session. Use **Open a project** or **New session**
to create one through the allowlisted picker.

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
- **⚠ HOVER-ONLY / focus-dependent surfaces → the OPERATOR drives, never the agent.**
  Some surfaces respond ONLY to a real `onMouseEnter` with no backgrounded or keyboard
  fallback (e.g. the Sidebar hover-expand rail). `cua-driver` has no backgrounded "hover"
  primitive, so driving them forces you to activate the window and **warp the real cursor** —
  which on 2026-07-07 repeatedly stole focus while the operator was working and forced a machine
  restart (verification screenshots were lost with it). For any check that depends on hover/focus
  with no backgrounded primitive: **STOP, hand the operator exact hover/click steps, and wait** —
  do NOT warp the cursor or steal focus. One approved focus-steal is NOT a standing license
  (cursor-warp feedback rule). If a hover/focus behavior can't be verified without stealing focus,
  mark it **UNVERIFIED** and defer to the operator (or close it by source inspection when the logic
  is trivial). A repeatable machine restart is never worth a checkbox.

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

## Model/Effort/Account For Migration Testing

Temporary, for the duration of the migration effort only — revert to normal
model/effort/account selection once all phases in `docs/migration/STATUS.md`
are ✅. Dev/testing turns (GUI verification runs and other migration dev-loop
testing) don't use the model's actual output — they only need a tool-call or
permission-prompt turn to fire so the surrounding app behavior can be
observed. Defaulting to a frontier model at high effort for that wastes real
usage/quota for no benefit.

- **Model:** GPT-5.6 Luna (`gpt-5.6-luna`). **The app boots into your DEFAULT
  (frontier) model — nothing auto-selects Luna — so set it BEFORE the first
  turn, or that turn already burns frontier quota.** Two ways:
  - **Preferred — set at launch (Luna is live before anything can fire):** prepend
    `ANTHROPIC_MODEL=gpt-5.6-luna` to the dev command, e.g.
    `ANTHROPIC_MODEL=gpt-5.6-luna CATCODE_TEST_CWD_ALLOWLIST=… CATCODE_DEBUG_STATE=1 bun run --cwd app dev`.
    Verified path: the supervisor spawns the sidecar with `{...process.env}`
    (`app/supervisor/supervisor.ts:218`), and with `mainLoopModel` at its null
    default the engine resolves the model from `ANTHROPIC_MODEL`
    (`getUserSpecifiedModelSetting`, `src/utils/model/model.ts:109`) — so the
    session is on Luna from turn one. Confirm on the composer's model face.
  - **In-app, from the composer run controls (P4-24c).** The composer rail
    carries live Model and Reasoning pickers, so a running session's model and
    effort CAN be changed without relaunching. They are ordinary controls, not
    dev-gated: `ComposerActionsBar.tsx:1187-1189` arms them purely on the live
    snapshot plus the setter handler, and a selection travels renderer → preload
    → main → sidecar to the engine's own `setMainLoopModelOverride` /
    `executeEffort` (`app/sidecar/runControlsDomain.ts:115-160`). Two real
    limits: the Reasoning picker is interactive only when the current model
    accepts an effort parameter, and a cross-provider model switch is refused
    once the session is provider-bound or has consumed input tokens. Setting the
    env var at launch is still preferred, because it has Luna live before the
    first turn can fire; the pickers are how you correct a session you already
    launched.
  - **Slash commands are NOT the way.** `/model` and `/effort` are `local-jsx`
    (`src/commands/model/index.ts:6`, `src/commands/effort/index.ts:5`) and the
    sidecar filters `local-jsx` out of the desktop slash catalog, since a
    non-interactive session has no terminal to render them into
    (`app/sidecar/sessionController.ts:441-448`). Use the composer pickers
    instead. Do NOT try to confirm via Settings → Diagnostics either: the Model
    row shows the explicit `mainLoopModel` *override*, which stays
    "Default"/null when the model comes from `ANTHROPIC_MODEL`, so it won't
    reflect Luna even though Luna is running.
- **Effort:** low, set from the composer's Reasoning picker (or inherited by a
  peer from its creator, below).
- **Peers:** a peer created with `CreatePeer` starts on its creator's model and
  effort unless the create names others (PEER-SESSIONS R7), so set Luna and low
  effort in the creator before creating test peers.
- **Account:** whichever Codex account is currently healthy — do not hardcode
  a specific account as policy. Check `/accounts` first; if the pool's active
  account is dead/capped, use `/switch-account <alias>` once to move onto a
  healthy one (a no-arg `/switch-account` only rotates among already-healthy
  accounts, so it won't help if the active slot itself is stuck on a dead
  one). Once more accounts are healthy again, let the pool rotate normally —
  don't keep pinning to whichever account you picked here.

## Honesty Rules

1. **The debug export may LOCATE and CROSS-CHECK, never substitute.** Every 🖐 acceptance claim must still cite an AX-observed label from the live window. Otherwise GUI rows stop testing rendering (reverse-Potemkin).
2. **P3-8 (the gate) must include at least ONE real picker interaction** so the bypass never hides a regression in the production create path.
3. **Standing convention for new surfaces (P3-6/P3-7/Phase-4 prompts):** every status-bearing element carries an aria-label with session identity + state, e.g. `"session catcode-gui-scratch — crashed, restorable"`. New UI ships agent-verifiable by construction; no retrofits.
4. **Use the registry for PID forensics.** `registry.json` already maps appSessionId ↔ enginePid/cwd/socketPath; use that map to kill or inspect the intended sidecar, and record the registry/debug-export evidence in the GUI report.
