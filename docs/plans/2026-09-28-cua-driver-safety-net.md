# cua-driver safety net

Date: 2026-09-28
Status: plan, revised after source review; not implemented
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
  ends it. It is also registered in `~/.cat-code/.cat-code.json` as a
  user-scoped stdio MCP server (`cua-driver mcp`), which runs as a child of the
  session for the session's lifetime.

## Goals

For cua-driver reached through the supported paths (the `cua-driver` command,
the `CuaDriver` app launch, and `mcp__cua-driver__*` tools):

- The engine, not the model, releases cua-driver when an agent's turn ends on
  any path, when the session exits, and when the agent stalls.
- The operator can always stop it, and an agent cannot undo the stop.
- The operator can see when an agent holds the machine.

This contains leftovers from normal agent work. It does not contain a model
deliberately evading the guard, for example by calling the app binary by an
unusual path from a script.

Non-goals: approval prompts, per-app grants or sensitive-app policies (the
operator wants agents free to drive), and changes to cua-driver itself.

## Design

A new engine module (proposed `src/utils/cuaDriver/`) owns detection, the
ownership record, the guard and release. It sends nothing to the renderer and
adds no protocol shapes.

### 1. Detection and guard placement

A tool call counts as cua-driver use when it is an `mcp__cua-driver__*` tool, or
a Bash command that invokes `cua-driver` or launches `CuaDriver`.

The guard inspects the final executable input: the `callInput` handed to the
tool in `src/services/tools/toolExecution.ts`, after PreToolUse hooks
(`hookUpdatedInput`) and the permission decision (`permissionDecision.updatedInput`)
have had their chance to replace it. A check before permissions could inspect a
different command from the one that runs.

### 2. Shared ownership record

One record in a harness-neutral place next to the daemon's socket, proposed
`~/Library/Caches/cua-driver/owner.json`, holding `{harness, sessionId, pid,
acquiredAt, lastUsedAt}` and created with O_EXCL. Both Cat Code and the Claude
Code hooks (see Outside the repo) use it. Modelled on
`src/utils/computerUse/computerUseLock.ts`.

- A session claims the record on its first cua-driver call. If another live
  owner holds it, the call is refused with a message saying cua-driver is in
  use by another session. Sessions no longer share a daemon.
- Ordinary release stops the daemon only when the record names this session.
- A record whose PID is dead is stale. Any harness may stop the daemon and
  clear the record.
- A running daemon with no record at all was started by hand or by a harness
  without the hooks. It is not stopped automatically. The guard refuses to use
  it and tells the operator, who can stop it or remove it.
- The operator's emergency stop stays global and ignores ownership.

### 3. Release on every turn end

A `finally` in the exported `query()` wrapper in `src/query.ts`. Every caller
goes through it (`QueryEngine`, the REPL, subagents, forked queries), and it
covers all terminal returns of `queryLoop`, thrown errors and a consumer
abandoning the generator. The three upstream cleanup sites are not enough: for
example, an API-error response returns `completed` before stop hooks run, and
`model_error`, `max_turns`, `hook_stopped`, `stop_hook_prevented` and
`prompt_too_long` also skip them.

Release runs only in the query invocation that made the claim, so a forked side
query finishing mid-turn cannot release the main thread's claim. Release then:

- runs `cua-driver stop`; if the socket does not answer, kills the PID that
  `cua-driver status` reported for the owned daemon;
- restarts the session's `cua-driver` MCP connection if that transport was used
  this turn, so its child process and any latched state go away. Whether
  `cua-driver mcp` runs its own driver or forwards to the socket daemon is
  unverified; confirm before implementing;
- kills any shell tasks tagged as cua-driver work (item 5);
- clears the record and sends the end notice.

### 4. Release on shutdown

On claim, register a handler with `registerCleanup`
(`src/utils/cleanupRegistry.ts`), as `computerUseLock.ts` does. The desktop
sidecar runs registered cleanup in `app/sidecar/sidecarCleanup.ts`, and the CLI
runs it on exit.

### 5. No cua-driver work outlives the turn

Bash commands can keep running after the tool returns: `run_in_background`,
auto-backgrounding on timeout, and assistant-mode auto-backgrounding
(`src/tools/BashTool/BashTool.tsx`). Such a command could restart the daemon or
keep acting after release or an emergency stop.

- The guard refuses cua-driver commands with `run_in_background`, and commands
  that detach themselves (`&`, `nohup`, `disown`, `setsid`). Starting the daemon
  itself is the exception, because the record and item 3 track it.
- Detected cua-driver commands are excluded from both auto-background paths.
- Release and the emergency stop kill shell tasks the guard tagged as
  cua-driver work, by the task's own PID, never by name.
- A shim at `~/.local/bin/cua-driver` (see Outside the repo) enforces the off
  switch for scripts the text check cannot see.

### 6. Subagents are refused

The guard refuses cua-driver in any subagent context (`toolUseContext.agentId`
set), foreground or background. Subagents inherit the parent's MCP clients
(`src/tools/AgentTool/runAgent.ts`) and can run Bash, and a foreground agent can
be moved to the background, where it would outlive the parent turn that
releases the claim. Per-agent ownership can come later; the `query()` `finally`
already gives each agent run its own end point.

### 7. Idle watchdog

While this session holds the record, if no cua-driver call arrives for
`IDLE_RELEASE_MS`, release as in item 3. A later call starts fresh and loses
only the element cache. Proposed value: 3 minutes.

### 8. Operator stop revokes access

When a turn that holds the record is aborted, set a per-session flag. While it
is set, the guard refuses cua-driver calls with a message modelled on Claude
Desktop's: the user stopped this session's use of the computer; do not use it
again unless the user asks. The flag clears on the operator's next typed
message.

### 9. Emergency off switch

A file, `<config home>/cua-driver.off`. While it exists, the guard refuses all
cua-driver calls in every session, and the shim refuses every CLI invocation.
The operator's hotkey creates it, then stops all cua-driver processes. Deleting
the file re-enables cua-driver; a slash command can come later.

### 10. Only in turns the operator started

Borrowed from Codex's turn gate. A turn that began from a peer message, task
notification or scheduled wakeup cannot claim the record. The implementation
must find the existing marker that separates operator prompts from those inputs
in `src/QueryEngine.ts` turn input.

### 11. Focus-changing shortcuts blocked

The guard refuses cua-driver `hotkey` and `press_key` calls for quit app
(`cmd+q`), switch app (`cmd+tab`, ``cmd+` ``) and lock screen (`ctrl+cmd+q`),
matching upstream's system-shortcut categories. This is a fixed deny list, not
a prompt.

### 12. Start and end notices

On claim: "Cat Code is using your computer. Press ⌃⌥⌘. to stop." (the hotkey
chosen below). On release: "Cat Code is done using your computer."
`sendOSNotification` is not wired in the desktop sidecar (no references in
`src/app-runtime/` or `app/sidecar/`), so v1 posts the notification from the
engine with `osascript -e 'display notification ...'`, which works in both CLI
and desktop sessions. A sidecar event to Electron main is the alternative, but
it would add a protocol shape under `app/shared/protocol.ts` versioning rules.

## Outside the repo

- `~/.cat-code/CLAUDE.md`: replace the ownership sentence with: the engine owns
  the cua-driver lifecycle; do not keep a daemon running after the task; if the
  guard refuses a call, report it instead of working around it.
- Shim: replace the `~/.local/bin/cua-driver` symlink with a script that exits
  with an error while `cua-driver.off` exists and otherwise `exec`s
  `/Applications/CuaDriver.app/Contents/MacOS/cua-driver "$@"`. The MCP
  registration launches through the same path, so it is covered too.
- Raycast script command bound to a global hotkey (silent mode):

  ```bash
  #!/bin/bash
  # @raycast.schemaVersion 1
  # @raycast.title Stop cua-driver
  # @raycast.mode silent
  touch "$HOME/.cat-code/cua-driver.off"
  cua-driver stop
  pkill -f 'CuaDriver.app/Contents/MacOS/cua-driver'
  ```

  The last line also ends one-shot CLI processes and MCP children. A global
  hotkey does not need its window to stay in front, so the focus fight should
  not block it. That is unverified until tested.
- Claude Code (upstream) sessions that load the `cua-driver` skill: its engine
  cannot be changed, so `~/.claude/settings.json` gets hooks that follow the
  shared record: a `PreToolUse` hook that claims it on a cua-driver command and
  denies while another live owner holds it or `cua-driver.off` exists, and a
  `Stop` hook that stops the daemon only when the record names this session.
  Claude Code has no interrupt hook, so an interrupted turn there keeps its
  claim until that session's next `Stop`, its exit (the record goes stale), or
  the emergency stop.
- Report the re-fronting defect to the cua-driver project with the evidence
  above and version 0.1.9. This is outward-facing and needs the operator's
  approval.

## Deferred

- Handing control back when the operator clicks in (Claude Desktop's takeover
  backoff). cua-driver exposes no user-input signal; this needs a native input
  monitor or a cua-driver change.
- Background versus full-screen control levels. cua-driver does not report when
  it takes focus, so the engine cannot draw the line.
- Per-agent ownership for subagents.
- Blocking actions while the screen is locked. Minor for this machine.

## Verification

Tests use an isolated config home, an isolated owner-record path, and a fake
`cua-driver` on `PATH` that records its arguments and fakes `status`. No test
drives the real GUI.

- Regression for the incident: a daemon with a stale record is stopped on the
  next session's first cua-driver call, and a session's own daemon is stopped
  at its turn end. Both fail against current code, which leaves the daemon
  running.
- Ownership across harnesses: a record written in the Claude Code hook format
  with a live PID is neither used nor stopped by Cat Code; the same record with
  a dead PID is recovered; a daemon with no record is refused, not stopped.
- Release on every end: natural stop, `aborted_streaming`, `aborted_tools`, an
  API error after a successful driver call, `max_turns`, a thrown error inside
  the loop, and shutdown cleanup. Turns that never used cua-driver do not
  release. A forked side query ending mid-turn does not release the main
  claim.
- Rewritten input: a PreToolUse hook `updatedInput` and a permission
  `updatedInput` that turn a harmless Bash call into a cua-driver call are both
  caught by the guard.
- Background work: `run_in_background` and self-detaching cua-driver commands
  are refused; a slow foreground cua-driver command is not auto-backgrounded;
  a tagged shell task is killed at release and at the emergency stop; the shim
  refuses while the off file exists.
- Guard refusals: in a subagent, after an operator abort until the next typed
  message, while the off file exists, in turns not started by the operator,
  and for each denied shortcut.
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
  operator-started turn for item 10.
- Hotkey: ⌃⌥⌘. proposed.
- Notification path: `osascript` for v1, or a desktop protocol event.
- A daemon with no ownership record: refuse and tell the operator (proposed),
  or stop it after a grace period.
