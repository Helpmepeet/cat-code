# cua-driver safety net

Date: 2026-09-28
Status: items 1 to 5 implemented on 2026-09-28 with D1 accepted and D2 kept
(idle stop included). Live check (a) and live checks (b) to (d) have not run.
Hotkey scripts are in `~/.cat-code/raycast/`; binding them in Raycast is an
operator step.
Scope: Cat Code engine (`src/`), plus user-level config outside the repo

## Why

On 2026-09-28 a desktop Chat (GPT-6 Sol, auto mode, engine session
`249a36d7-7c27-4dfb-9282-462e0febb5e2`) drove System Settings with the
`cua-driver` CLI to remove a Roblox login item. The operator then could not
keep any app in front for about nine minutes.

Evidence (macOS unified log, WindowServer and runningboard entries):

- The `cua-driver serve` daemon (pid 3104) was already running when the Chat
  started. No LaunchAgent or login item starts it.
- From 14:17:50, three seconds after one of the Chat's `get_window_state`
  calls, the daemon made Goodnotes the front process 175 times. Every switch to
  Chrome, VS Code, Cat Code Dev, iTerm2, Activity Monitor or ChatGPT was undone
  within about 6 ms. WindowServer logs these as
  `dcda3[SetFrontProcessWithInfo]`, and at process death names connection
  `DCDA3` as "Cua Driver" pid 3104.
- The Chat's last cua-driver call was 14:21:00 and its turn ended at 14:22:17.
  The re-fronting continued until the daemon was killed at 14:26:31. The next
  app switch, at 14:27:01, held.
- The Chat did not stop the daemon because `~/.cat-code/CLAUDE.md` says "never
  stop a pre-existing shared daemon", a rule added on 2026-09-02 after the same
  symptom.
- Codex's Computer Use service, killed at the same moment, started at
  14:23:29, after the lockout began. It was not the cause.

The operator's ruling: agents should keep using cua-driver. The failure is that
nothing released it when the agent finished.

## How cua-driver actually runs

- `cua-driver serve` is a long-running daemon on a Unix socket. It has no
  session, idle exit or turn awareness. It relaunches itself through
  LaunchServices, so it is never a child of whoever started it. Only
  `cua-driver stop` or a kill ends it.
- `cua-driver call` forwards to the daemon's socket when one exists.
- cua-driver is registered in `~/.cat-code/.cat-code.json` as a user-scoped
  stdio MCP server (`cua-driver mcp`). Every desktop sidecar starts it as a
  child at session start: on 2026-09-28 at 17:13, two sidecars started at
  17:12:49 and 17:13:14 each had a `cua-driver mcp` child.
- Per `cua-driver mcp --help`, when launched without CuaDriver.app's TCC
  grants, as Cat Code launches it, the MCP server ensures a `serve` daemon is
  running and forwards every tool call to it. So both routes act through the
  same daemon. This is from the help text and is live check (a).
- Consequence: a running daemon is normal. A daemon (pid 79607) started at
  16:49:30, four seconds before a session's first message, and that session
  never used cua-driver. pid 3104 most likely started the same way. Daemons are
  started by session plumbing, not by agents, so "who owns the daemon" does not
  describe reality. The hazard is a daemon still holding state from GUI actions
  after the agent is done.

## What the other harnesses do

Neither Claude Code nor Codex uses cua-driver. Both release computer use in the
host, not the model.

- Claude Code CLI (upstream code in this fork, `src/utils/computerUse/`,
  compiled out because `CHICAGO_MCP` is not in `scripts/build.ts`): cleanup at
  natural turn end and both abort paths, an atomic lock with stale-PID
  recovery, a global Escape abort, and start and end notices.
- Claude Desktop: release at every turn end, an idle and hang watchdog, a
  10 s backoff when the user clicks into a driven app, and an emergency stop
  that revokes access.
- Current upstream CLI (2.1.270): background control by default, full-screen
  takeover as a separate consented mode with a visible border, and a grant for
  system shortcuts.
- Codex: `Stop`, `Interrupt` and `SubagentStop` hooks call `turn_ended`, after
  which the service refuses until the next user message.

## Goals

For cua-driver reached through the `cua-driver` command or
`mcp__cua-driver__*` tools:

- When a run that used cua-driver ends, on any path, the daemon is stopped, so
  no GUI-action state outlives the agent's work.
- The operator can always stop it, and the agent cannot undo that stop.
- If D2 is accepted: a run that stops using cua-driver but keeps going does not
  keep the daemon.

Non-goals: approval prompts, per-app grants or sensitive-app policies (the
operator wants agents free to drive), and changes to cua-driver itself.

## Design

A small engine module, `src/utils/cuaDriver/` (`run.ts` and `guard.ts`).

### 1. Stop at the end of any run that used it

A `finally` in the exported `query()` wrapper in `src/query.ts`. Every caller
goes through it (`QueryEngine`, the REPL, subagents, forked queries), and it
covers every terminal return of `queryLoop` (including the API-error
`completed` path, `model_error`, `max_turns` and hook stops), thrown errors,
and a consumer abandoning the generator.

The guard (item 2) marks the run when it sees a cua-driver call. In the
`finally`, a marked run executes `cua-driver stop`. Runs that never called
cua-driver do nothing, so a forked side query cannot stop a daemon mid-turn.
Subagents are covered by their own run's `finally`; no separate rule is needed.

### 2. One guard check on the final tool input

In `src/services/tools/toolExecution.ts`, on the `callInput` handed to the tool,
after PreToolUse hooks and the permission decision may have replaced it. A call
counts as cua-driver use when it is an `mcp__cua-driver__*` tool, or a Bash
command that invokes `cua-driver` or launches `CuaDriver`. The guard does two
things: marks the run for item 1, and refuses the call while the off switch
exists (item 3).

### 3. Operator stop that sticks

A file, `<config home>/cua-driver.off`. While it exists, the guard refuses
every cua-driver call in every session, with a message telling the model the
operator stopped computer use and it must not work around it. Without this, an
agent could restart the daemon within seconds of a stop.

- Raycast script command bound to a global hotkey (silent mode):

  ```bash
  #!/bin/bash
  # @raycast.schemaVersion 1
  # @raycast.title Stop cua-driver
  # @raycast.mode silent
  touch "$HOME/.cat-code/cua-driver.off"
  cua-driver stop
  pkill -f 'CuaDriver.app/Contents/MacOS/cua-driver serve'
  ```

- A second script command deletes the file to allow cua-driver again.
- A global hotkey does not need its window to stay in front, so the focus
  fight should not block it. Live check (c) proves it.

### 4. Idle stop (only if D2 is accepted)

When the guard marks a run, it re-arms a per-run timer. If the run makes no
cua-driver call for 3 minutes and has not ended, the timer runs
`cua-driver stop`. A later call in the same run starts fresh, loses only the
element cache, and re-arms the timer. The `finally` clears the timer.

### 5. Rule text

Replace the ownership sentence in `~/.cat-code/CLAUDE.md` with: the engine
stops cua-driver at the end of any run that used it; if the guard refuses a
call, report it instead of working around it.

## Decisions needed

**D1. Stopping can interrupt another session's GUI task.** When one run ends,
`cua-driver stop` also cuts off any other session driving the GUI at that
moment. Proposed: accept it. This machine has one operator, concurrent GUI
tasks are rare, and the interrupted session recovers by re-snapshotting on its
next call (the CLI route restarts the daemon; the MCP route depends on check
(a)). The alternative is coordination: a shared last-use marker so a run skips
the stop while another session used cua-driver in the last few seconds. That
brings back part of the ownership system.

**D2. Stall and long-turn release.** Without item 4, a run that used cua-driver
early and then works for an hour keeps the daemon for that hour, and the goal
of release when the agent stalls is dropped. Proposed: keep item 4. It is a
timer in the same module, and long GPT turns that use the GUI early are
realistic.

## Live check (a), before implementation

It needs operator authorization, because it stops the shared daemon (currently
the one other sessions' MCP servers forward to) and starts a new one.

- With a session's `cua-driver mcp` server running, run `cua-driver stop`, then
  make one read-only `list_apps` call through that MCP server.
- If the call starts a new daemon and succeeds: items 1 to 5 are enough.
- If it fails: stopping at run end breaks the MCP route for the rest of that
  session. Then either item 1 also reconnects the session's `cua-driver` MCP
  server, or cua-driver is removed from the MCP registration and used through
  the CLI only.
- It may be possible to run this against a private socket
  (`serve --socket` and `mcp --socket`) without touching the shared daemon, if
  the MCP server passes its socket to the daemon it launches. That is also
  unverified.

## Not covered

- The lockout during a turn: from the first bad action to run end, the idle
  stop or the hotkey. In the incident that was 14:17:50 to 14:22:17. Only a
  cua-driver fix or detecting the operator's input prevents it.
- A daemon latched by a crashed session or by a Claude Code session, until the
  hotkey or the next Cat Code run that uses cua-driver.
- cua-driver work already running in a background shell or script when the
  stop happens. The off switch blocks only new tool calls.
- Using cua-driver again in the next turn after the in-app stop button. Only
  the hotkey's off switch blocks that.
- Another session's in-progress GUI task, if D1 is accepted.

## Deferred from the larger draft

Each can come back if evidence shows the gap in practice.

- Ownership records and cross-harness rules: daemons are started by session
  plumbing, not by agents.
- Tracking or refusing background cua-driver shell work, and a CLI wrapper
  script: no evidence either happens.
- Restarting the MCP connection at release: needed only if check (a) fails.
- Subagent refusal: item 1 covers subagents.
- Shutdown release: a crash skips it anyway; the hotkey covers leftovers.
- Start and end notices, revoking access after the in-app stop, allowing
  cua-driver only in operator-started turns, and a deny list for quit, switch
  and lock-screen shortcuts: none is tied to how this incident happened.
- Claude Code hooks for sessions that load the `cua-driver` skill.
- Handing control back when the operator clicks in, and background versus
  full-screen control levels: need a native helper or a cua-driver change.

Separately, report the re-fronting defect to the cua-driver project with the
evidence above and version 0.1.9. This is outward-facing and needs the
operator's approval.

## Verification

Tests use an isolated config home and a fake `cua-driver` on `PATH` that
records its arguments. No test drives the real GUI.

- Regression for the incident: a run that called cua-driver ends and
  `cua-driver stop` is invoked. This fails against current code.
- Every end path invokes the stop for a marked run: natural stop,
  `aborted_streaming`, `aborted_tools`, an API error after a successful driver
  call, `max_turns`, and a thrown error. An unmarked run and a forked side
  query do not.
- A subagent run that called cua-driver invokes the stop when it ends.
- Rewritten input: a PreToolUse hook `updatedInput` and a permission
  `updatedInput` that turn a harmless Bash call into a cua-driver call are
  caught by the guard.
- While the off file exists, CLI and MCP cua-driver calls are refused in any
  session.
- If D2: the idle timer with fake timers stops the daemon after 3 minutes
  without a call, and a later call re-arms it.
- Checks: `bun run build:dev:full` and the new test paths.

Live checks after implementation, operator-authorized:

- (b) In a desktop Chat, on a normal finish and on the in-app stop,
  `cua-driver status` shows no daemon within about a second of the run ending.
- (c) The hotkey works while another app is in front, and afterwards CLI and
  MCP calls are refused. A new session starting in that state may launch an
  idle daemon; that is expected.
- (d) After a stop, the WindowServer log shows no further
  `SetFrontProcessWithInfo` from a cua-driver connection. The real lockout
  cannot be rehearsed, because its trigger is unknown.

After implementation, add the module to
`docs/maps/native-client-integrations.md`.
