# Packaged desktop quit regression

The regression starts at `19c92d0b`. Its lid-cleanup promise resumes `app.quit()`
inside Electron's native `before-quit` emission. The canceled outer quit then
overwrites the nested quit's state. The window closes, but macOS parks the
process instead of exiting. This also affects the native **Quit Cat Code** menu.

## Source mechanism

The packaged runtime uses Electron **33.4.11**. In
[`Browser::Quit`](https://github.com/electron/electron/blob/v33.4.11/shell/browser/browser.cc#L80-L91),
`is_quitting_ = HandleBeforeQuit()` assigns the result only after the event
emission returns. Electron's
[event callback bridge](https://github.com/electron/electron/blob/v33.4.11/shell/common/gin_helper/event_emitter_caller.cc#L20-L29)
performs a microtask checkpoint before returning to native code.

At `6eb41c0b`, `app/main/main.ts` cancels `before-quit`, clears `lidMode`, and
calls `ending.shutdown().finally(() => { lidQuitFinished = true; app.quit() })`.
With no active lid lease, `LidClosedMode.shutdown()` settles through promises
without waiting for native restoration I/O. Its `finally` runs in that checkpoint:

1. The outer quit has not yet assigned `is_quitting_`.
2. The nested quit sees the cleared lid owner, takes the normal teardown branch,
   logs completion, assigns its quitting flag, and requests window closure.
3. The outer canceled quit returns and overwrites the flag with `false`.
4. When the last window closes,
   [`Browser::OnWindowAllClosed`](https://github.com/electron/electron/blob/v33.4.11/shell/browser/browser.cc#L255-L263)
   emits `window-all-closed` instead of completing the quit. Our darwin handler
   logs `app.parked.windowless` and leaves the process running.

`process.exited` is an anticipatory application log written in `before-quit`,
not an OS exit observation. `operationalLogSink.close()` closes its file
descriptor; the next write calls `ensureOpen()` and opens another file with the
same launch ID and PID. That explains both the misleading exit record and the
new log file. The full smoke checks actual child-process termination separately.

SIGTERM takes the native quit path because Electron installs its own handlers
after JavaScript startup. Its
[`PostCreateMainMessageLoop`](https://github.com/electron/electron/blob/v33.4.11/shell/browser/electron_browser_main_parts.cc#L501-L505)
connects shutdown signals to `Browser::Quit`; the
[POSIX implementation](https://github.com/electron/electron/blob/v33.4.11/shell/browser/electron_browser_main_parts_posix.cc)
installs them with `sigaction`, writes the signal to a pipe, and posts the quit
callback to the UI thread. Our earlier Node `process.on('SIGTERM')` listener is
therefore bypassed in these runs. A `before-quit` reason is expected here.

## Packaged history comparison

All builds used clean detached checkouts in a local clone under `/private/tmp`,
with installed dependencies reused unchanged. Both historical lockfiles pin
Electron 33.4.11; the manifest change adds the asar/fuse packaging tools. Build
output recorded each SHA without `-dirty`. Each smoke used scratch HOME, config, and Electron
profile directories and ran outside the shell sandbox so Electron could launch.

| Commit | Full packaged smoke before repair |
| --- | --- |
| `f82633e7` (`19c92d0b^`) | All assertions pass |
| `19c92d0b` | Only SIGTERM exit assertion fails |
| `53ffb729` | Only SIGTERM exit assertion fails |
| `6eb41c0b` | SIGTERM exit fails; added no-parking regression also fails |

`53ffb729` retains the faulty handler from `19c92d0b`; its packaging changes did
not introduce this regression.

## Independent runtime observations

A clean HEAD bundle copied into the scratch evidence directory reproduced the
manual 25-second wait and SIGTERM case. PID **52791** logged:

| UTC timestamp, 2026-10-16 | Event |
| --- | --- |
| 10:17:47.638 | `app.shutdown.started`, reason `before-quit` |
| 10:17:47.642 | `app.shutdown.completed` and main `process.exited` |
| 10:17:47.648 | `app.parked.windowless`, same launch ID and PID |

It remained alive for the full 16-second deadline and required SIGKILL.

For native menu verification, accessibility inspection identified the scratch
bundle's window URL and **Quit Cat Code**, action `terminate:`. Clicking it on
PID **53390** closed the window and produced the same completion/parking
sequence at 10:21:08 UTC. An exact-PID `ps` check still showed the process alive
afterward; it was explicitly SIGKILLed. This was an actual menu action, not an
injected JavaScript `app.quit()` call. An initial accessibility discovery exceeded
its test deadline and was discarded; the successful inspection used a fresh run.

## Repair and regression

The repair schedules the resumed quit with `setImmediate` after lid cleanup.
This lets the canceled native quit unwind before another quit begins. It retains
the cleanup wait and normal Electron window-closing lifecycle. The stale comment
claiming that all SIGTERM deliveries bypass `before-quit` is corrected.

The existing `app/scripts/packaged-launch-smoke.ts` owns the regression at the
actual packaged process boundary. It now also rejects `app.parked.windowless`
after SIGTERM. Against the unchanged clean HEAD bundle, both the 15-second exit
assertion and this added assertion failed; all other assertions passed. No
production injection flag or mocked Electron quit implementation is added.

The repaired package was built from clean scratch commit `a6797d94`, containing
only the main-process repair and smoke change. Its full
`bun run --cwd app smoke:packaged` passed, including actual SIGTERM exit and the
new no-parking check. A separate repeat of the 25-second idle/SIGTERM probe
(PID **57103**) exited **0 in 153 ms**, retained the expected `before-quit`
shutdown reason, and recorded no windowless parking. This validates the native
signal explanation as well as the repair.

Native **Quit Cat Code** also exits the repaired bundle: accessibility reported
`App quit`, the subprocess exited **0**, and an exact-PID check confirmed PID
**56752** was gone. Its operational log contains the normal shutdown sequence
with no parking record. Cmd-Q was not exercised separately.

Both `bun run --cwd app typecheck` and `typecheck:sidecar` passed. The runtime
hardening harness passed **19/19** checks. Its scratch runner added an explicit
scratch `--user-data-dir` to preserve profile isolation, then was restored; this
runner change is not part of the repair. An earlier profile preload ran before
Electron exposed its API and was discarded. `bun run maps:lint` also passed.

The full repaired `bun test app/` run completed: **5,940 pass, 3 skip, 19 fail**
across 417 files. The failures cover credential-dependent real-sidecar startup,
relocation, run controls, and peer-tool assertions. All 19 failures reproduced
on unchanged `6eb41c0b` in a second clean clone with scratch state. That baseline
completed with **5,939 pass, 3 skip, 20 fail**; its additional failure was the
five-second timeout in `packaged preload strips debug-state sender while dev
preload contains it`. There are no repair-only failures. No credentials were
introduced to make these checks pass. The full suites remain red; the packaged
quit regression, both typechecks, and isolated hardening harness pass.

The repaired package's `main.ts` and packaged-smoke source blobs exactly match
the proposed shared-checkout files (`217cd7b3` and `51726757`, respectively).
The report is the only additional file in the final shared-checkout commit.

## Evidence and boundaries

Local evidence is retained under `/private/tmp/catcode-quit-evidence` and in
`/private/tmp/catcode-quit-*.log`. Historical build and smoke files use the
`pre-lid`, `lid`, `authority`, and `head` labels. Early sandbox-blocked and
overlapping build attempts were discarded, followed by sequential clean builds
and valid runs reported above.

No live user profile, installed app, `/Applications` bundle, helper installation,
power setting, or physical lid operation was changed. Only exact spawned PIDs
were terminated. These checks qualify the desktop quit regression; they do not
qualify privileged-helper authentication or physical lid-closed operation.
