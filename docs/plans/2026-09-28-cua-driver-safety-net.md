# cua-driver safety net

Date: 2026-09-28
Status: plan, not implemented
Scope: Cat Code engine (`src/`), plus user-level config outside the repo

## Why

On 2026-09-28 a desktop Chat (GPT-6 Sol, auto mode, engine session
`249a36d7-7c27-4dfb-9282-462e0febb5e2`) drove System Settings with the
`cua-driver` CLI to remove a Roblox login item. The operator then could not
keep any app in front for about nine minutes.

Evidence (macOS unified log, WindowServer and runningboard entries):

- The `cua-driver serve` daemon (pid 3104) was already running when the Chat
  started. No LaunchAgent or login item starts it; an earlier session left it.
- From 14:17:50 the daemon made Goodnotes the front process 175 times. Every
  switch to Chrome, VS Code, Cat Code Dev, iTerm2, Activity Monitor or ChatGPT
  was undone within about 6 ms. WindowServer logs these as
  `dcda3[SetFrontProcessWithInfo]`, and at process death names connection
  `DCDA3` as "Cua Driver" pid 3104.
- The Chat's last cua-driver call was 14:21:00 and its turn ended at 14:22:17.
  The re-fronting continued until the daemon was killed at 14:26:31. The next
  app switch, at 14:27:01, held.
- The Chat did not stop the daemon because `~/.cat-code/CLAUDE.md` says "never
  stop a pre-existing shared daemon". A 2026-09-02 session (`7ebb22bb`,
  GPT-5.6 Terra) added that rule after the same symptom (focus pulled back to
  Cat Code), to avoid killing another session's automation.
- Codex's Computer Use service, killed at the same moment, started at
  14:23:29, after the lockout began. It was not the cause.

The operator's ruling: agents should keep using cua-driver. The failure is that
nothing released it when the agent finished.

## What the other harnesses do

Neither Claude Code nor Codex uses cua-driver. Both make release the host's job.

- Claude Code CLI (upstream code in this fork, `src/utils/computerUse/`,
  compiled out because `CHICAGO_MCP` is not in `scripts/build.ts`):
  `cleanupComputerUseAfterTurn` runs at natural turn end
  (`src/query/stopHooks.ts`) and on both abort paths (`src/query.ts`,
  `aborted_streaming` and `aborted_tools`). `computerUseLock.ts` holds one
  atomic lock file with stale-PID recovery and a shutdown cleanup handler.
  `escHotkey.ts` aborts the turn on a bare Escape. Start and end notices read
  "Claude is using your computer · press Esc to stop" and "Claude is done
  using your computer".
- Claude Desktop: every turn end releases the lock, un-hides apps and restores
  the clipboard. An idle and hang watchdog releases stuck sessions. A user
  click into a driven app releases background control and backs off for 10 s.
  An emergency stop revokes access, and requests right after a stop are set
  aside.
- Current upstream CLI (2.1.270): background per-app control by default;
  taking over the screen is a separate consented mode with a glow border and an
  explicit release. System shortcuts (quit app, switch app, lock screen) need
  their own grant.
- Codex: its plugin maps `Stop`, `Interrupt` and `SubagentStop` hooks to
  `turn_ended`, after which the service refuses with "Computer Use is
  unavailable because the current turn ended. It will work again after the
  next user message."
- cua-driver: a long-running daemon with no session, idle exit or turn
  awareness. `serve` relaunches itself through LaunchServices, so the daemon is
  never a child of the agent that started it. Only `cua-driver stop` or a kill
  ends it.

## Goals

- The engine, not the model, releases cua-driver whenever an agent is done,
  including when the operator interrupts, the session exits, or the agent
  stalls.
- The operator can always stop it, and a stop cannot be undone by the agent
  restarting the daemon.
- The operator can see when an agent holds the machine.

Non-goals: approval prompts, per-app grants or sensitive-app policies (the
operator wants agents free to drive), and changes to cua-driver itself.

## Design

A new engine module (proposed `src/utils/cuaDriver/`) owns detection, the
lock, the guard and cleanup. The guard runs in the tool execution path ahead of
permissions (`src/services/tools/toolExecution.ts`), so it applies in every
permission mode and the model cannot talk its way past it. It sends nothing to
the renderer and adds no protocol shapes.

### 1. Detection

A tool call counts as cua-driver use when it is an `mcp__cua-driver__*` tool, or
a Bash command that invokes `cua-driver` (the CLI) or launches `CuaDriver`.
Parsing is by command text, so a script file that calls cua-driver indirectly
is not seen. The ownership check in item 2 covers that gap at the next direct
call.

### 2. Owner lock, one session at a time

Modelled on `src/utils/computerUse/computerUseLock.ts`.

- Lock file `<config home>/cua-driver.lock` holding `{sessionId, pid,
  acquiredAt, lastUsedAt}`, created with O_EXCL.
- Acquired on a session's first cua-driver call. If another live session holds
  it, the call is refused with a message saying cua-driver is in use by another
  session. Sharing a daemon between sessions is no longer allowed, which
  removes the reason for the "never stop a pre-existing daemon" rule.
- If the owner PID is dead, the lock is stale: recover it.
- If a daemon is running and no live session owns it, it is an orphan: stop it
  before the call proceeds. This is the incident's case.

### 3. Release at turn end and on interrupt

At the three places upstream calls `cleanupComputerUseAfterTurn`
(`src/query/stopHooks.ts`, and the `aborted_streaming` and `aborted_tools`
returns in `src/query.ts`), outside the `CHICAGO_MCP` gate: if this session
holds the lock, run `cua-driver stop`, release the lock and send the end
notice. If the socket does not answer, fall back to killing the PID that
`cua-driver status` reported for the owned daemon. Follow upstream in skipping
subagent contexts (`toolUseContext.agentId`); the parent turn's end covers
them. Desktop sessions reach these points because `QueryEngine` runs
`query.ts`.

### 4. Release on shutdown

On acquire, register a handler with `registerCleanup`
(`src/utils/cleanupRegistry.ts`), as `computerUseLock.ts` does. The desktop
sidecar runs registered cleanup in `app/sidecar/sidecarCleanup.ts`, and the CLI
runs it on exit.

### 5. Idle watchdog

While the lock is held, if no cua-driver call arrives for `IDLE_RELEASE_MS`,
stop the daemon and release the lock. A later call starts fresh and loses only
the element cache. Proposed value: 3 minutes.

### 6. Operator stop revokes access

When a turn that holds the lock is aborted, set a per-session flag. While it is
set, the guard refuses cua-driver calls with a message modelled on Claude
Desktop's: the user stopped this session's use of the computer; do not use it
again unless the user asks. The flag clears on the operator's next typed
message.

### 7. Emergency off switch

A file, `<config home>/cua-driver.off`. While it exists, the guard refuses all
cua-driver calls in every session. The operator's hotkey (below) creates it
and then stops the daemon, so an agent cannot undo the stop by starting a new
daemon. Deleting the file re-enables cua-driver; a slash command can come
later.

### 8. Only in turns the operator started

Borrowed from Codex's turn gate. A turn that began from a peer message, task
notification or scheduled wakeup cannot acquire the lock. The implementation
must find the existing marker that separates operator prompts from those inputs
in `src/QueryEngine.ts` turn input.

### 9. Focus-changing shortcuts blocked

The guard refuses cua-driver `hotkey` and `press_key` calls for quit app
(`cmd+q`), switch app (`cmd+tab`, ``cmd+` ``) and lock screen (`ctrl+cmd+q`),
matching upstream's system-shortcut categories. This is a fixed deny list, not
a prompt.

### 10. Start and end notices

On lock acquire: "Cat Code is using your computer. Press ⌃⌥⌘. to stop." (the
hotkey chosen below). On release: "Cat Code is done using your computer."
`sendOSNotification` is not wired in the desktop sidecar (no references in
`src/app-runtime/` or `app/sidecar/`), so v1 posts the notification from the
engine with `osascript -e 'display notification ...'`, which works in both CLI
and desktop sessions. A sidecar event to Electron main is the alternative, but
it would add a protocol shape under `app/shared/protocol.ts` versioning rules.

## Outside the repo

- `~/.cat-code/CLAUDE.md`: replace the ownership sentence with: the engine owns
  the cua-driver lifecycle; do not keep a daemon running after the task; if the
  guard refuses a call, report it instead of working around it.
- Raycast script command bound to a global hotkey (silent mode):

  ```bash
  #!/bin/bash
  # @raycast.schemaVersion 1
  # @raycast.title Stop cua-driver
  # @raycast.mode silent
  touch "$HOME/.cat-code/cua-driver.off"
  cua-driver stop || pkill -f 'CuaDriver.app/Contents/MacOS/cua-driver serve'
  ```

  A global hotkey does not need its window to stay in front, so the focus fight
  should not block it. That is unverified until tested.
- Claude Code (upstream) sessions that load the `cua-driver` skill: its engine
  cannot be changed, so `~/.claude/settings.json` gets the subset hooks allow:
  a `Stop` hook that stops the daemon when the session used it, and a
  `PreToolUse` hook that denies cua-driver while `cua-driver.off` exists. Claude
  Code has no interrupt hook, so this does not cover interrupts there.
- Report the re-fronting defect to the cua-driver project with the evidence
  above and version 0.1.9. This is outward-facing and needs the operator's
  approval.

## Deferred

- Handing control back when the operator clicks in (Claude Desktop's takeover
  backoff). cua-driver exposes no user-input signal; this needs a native input
  monitor or a cua-driver change.
- Background versus full-screen control levels. cua-driver does not report when
  it takes focus, so the engine cannot draw the line.
- Blocking actions while the screen is locked. Minor for this machine.

## Verification

Tests use an isolated config home and a fake `cua-driver` on `PATH` that
records its arguments and fakes `status`. No test drives the real GUI.

- Regression for the incident: a daemon running with no live owner is stopped
  on the next session's first cua-driver call. This fails against current
  code, which leaves it running.
- Lock: atomic acquire, refusal while another live session holds it, stale-PID
  recovery.
- Release is called at natural turn end, `aborted_streaming`, `aborted_tools`
  and shutdown cleanup, and not for turns that never used cua-driver.
- Guard refusals: after an operator abort until the next typed message, while
  the off file exists, in turns not started by the operator, and for each
  denied shortcut.
- Idle watchdog with fake timers.
- Checks: `bun run build:dev:full` and the new test paths; if `app/sidecar/`
  changes, `bun test app/`, `bun run --cwd app typecheck` and
  `bun run --cwd app typecheck:sidecar`.
- Live check, operator-authorized: in a desktop Chat, start a cua-driver task,
  press stop mid-turn, and confirm the daemon is gone, the next call is
  refused, and both notices appeared. Then trigger the hotkey during a run and
  confirm the agent cannot restart the daemon.
- After implementation, add the new module to
  `docs/maps/native-client-integrations.md`.

## Open decisions

- Idle timeout: 3 minutes proposed.
- Whether a peer the operator explicitly asked to do GUI work counts as an
  operator-started turn for item 8.
- Hotkey: ⌃⌥⌘. proposed.
- Notification path: `osascript` for v1, or a desktop protocol event.
