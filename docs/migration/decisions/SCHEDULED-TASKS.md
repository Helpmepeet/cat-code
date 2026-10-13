# Native scheduled tasks

Date: 2026-10-13. The user requested recurring work in Cat Code so workspace-map
maintenance no longer needs ChatGPT scheduling. Exact reference-product parity
is not required.

## Ownership and scope

`app/host/scheduledTasks.ts` owns durable task definitions, individual run claims,
and lifecycle tracking. Electron main starts and stops it with the existing host.
The backend exposes three fixed preload methods; main validates closed inputs.
Workspace identity comes from an opaque saved-project handle or a
single-use native picker token. Renderer-authored filesystem paths, resume
identities, permission rules, and bypass mode are rejected.

Each run creates an ordinary session through `Host.createSession`, waits for
socket readiness through `launchScheduledSession`, and submits through the
existing `app.submit` receiving boundary. It uses the real engine, workspace
trust, tools, permission requests, transcripts, and normal session lifecycle.
Model, effort, and default/auto permission mode use the existing spawn controls.
No sidecar wire kinds, engine permissions, or locked process topology change.

The first version supports independent runs, daily/weekday/weekly wall-clock
times in a saved timezone, and minute intervals. Runs continue independently of
renderer pages while a Cat Code window and its host remain open. Closing the last
window stops scheduling under the existing desktop lifetime contract. It does
not install an OS daemon, wake a sleeping computer, or execute in the cloud.

## Durable dispatch and results

The scheduler holds an exclusive lock on the canonical
`<Cat Code config home>/desktop/scheduled-tasks.json` path before reading or
recovering it. Dev and packaged apps have different Electron profile locks;
only one can own this shared scheduling store. Writes use a private
temporary file, file sync, rename, and directory sync. A read failure preserves
the existing document and leaves scheduling unavailable. A failed write freezes
dispatch rather than allowing execution whose claim was not saved.

A run's stable chat identity and dispatch claim reach disk before creating its
engine process. The exact ready engine identity is saved through the real
registry before prompt submission. A task can have one unfinished run. Overdue recurring work runs
once and moves the next occurrence into the future; missed occurrences are not
replayed. Recurring tasks persist until paused or deleted and do not inherit
terminal cron's seven-day expiry. Run now works for paused tasks and leaves the
next scheduled time alone. Pause and delete affect future dispatches; they do
not abort an already claimed run. Deleting a task keeps its run chats and history.

Readiness, prompt delivery, permission waits, and turn results remain distinct.
An SDK result alone does not finish the run: completion also waits for the real
controller's inactive-turn event. Replayed history cannot complete a live run.
An unfinished run after host restart becomes interrupted and is not resubmitted.
The user can inspect or continue its saved chat. Explicit close or restart
interrupts the old run. A failed launch/refused prompt
is recorded and not automatically redelivered. A definite host capacity or
branch-switch refusal before process creation retains the same starting claim
and retries admission on a later tick. This bounded queue preserves the captured
prompt and controls through pause/delete; restart interrupts it without replay.
These rules avoid pretending
exactly-once execution across an uncertain crash boundary.

Completed means the agent turn ended successfully, not that its requested work
was semantically successful. The final report remains available in the chat and
as a bounded run summary. A permission or question request records `waiting`
and keeps the task unfinished. The store retains 200 recent runs,
including every unfinished run, and at most 50 definitions. A new claim is refused
when all 200 history slots are unfinished; active claims are never evicted.

## Workspace-map migration

The `workspace-maps` command creates a paused daily 03:00 Asia/Bangkok task for the
selected project. The preset requires that project's existing refresh helper.
Its prompt uses the helper's start, review, check, finish, block, and recovery
contract, explicit map paths, scoped commits, committed source, and preserved
unrelated work.

State belongs to
`<Cat Code config home>/desktop/workspace-map-refresh/<workspace hash>`.
On explicit preset creation, a matching legacy Codex helper state is copied
once without changing its bytes or the old state. Import publishes complete
bytes atomically without replacing an existing native cursor; failed partial
writes can be retried. Invalid existing native state is refused and preserved.
Active review/commit states are refused. The prompt shell-quotes its state path
and leaves another owner's active helper lease untouched. Later scheduled runs use only Cat Code state. The preset remains
usable without any legacy state and will perform the helper's baseline review.

Pause the previous external schedule before enabling this task to keep one
refresh owner. Creating the feature or preset does not edit external scheduling
definitions, start a live model turn, or install a new application build.

## Desktop interface

Amended 2026-10-13: the interface, first deferred to a separate design pass, is now built.
`app/renderer/src/ScheduledTasksPage.tsx` is the Scheduled page tab, opened from
the sidebar. The user approved its layout in
`docs/design-html/2026-10-13-scheduled-page-directions.html`: a task list panel
(New task, Upcoming by next run, Paused, a workspace-map suggestion while no
preset exists, and Run history) beside one detail pane. With nothing selected the
pane shows activity: unfinished runs, answers needed first, then recent runs. A
task's pane is a runs timeline (next run, current run, finished runs) followed by
its instructions; an Active switch pauses and resumes it. Below the `md` width the
list and the pane are shown one at a time.

`scheduledTasksModel.ts` owns draft conversion, validation that mirrors the
receiving parser, ordering, and status vocabulary. The page reads the pull API
every five seconds while visible and when the window returns; a response issued
before the last applied one is dropped, so a slow poll cannot undo a command
result. One draft is open at a time and survives switching tabs, not renderer
reload; New task and Edit return to it rather than replacing it.

A refused save that carried a picker token asks for the folder again, because
main consumes the token before validating the save. An edit takes `enabled`
from the latest snapshot. Turning on the workspace-map preset requires confirming
that the previous external schedule is paused. "Turn completed" names a
finished agent turn, not semantic success. Run chats open through the same
registry route as created-peer links. Model suggestions come from the real engine's
unlocked model catalog; any parser-valid model name is accepted. The editor's next
run preview calls `nextTaskOccurrence`, which moved unchanged from the host into
`app/shared/scheduledTasks.ts` so the preview and the scheduler share one rule.

The backend contract the page uses:

| Method | Contract |
| --- | --- |
| `window.catcode.readScheduledTasks()` | Returns task definitions, recent runs, and an optional storage/startup error. This is a pull API; there is no schedule event subscription. |
| `window.catcode.readScheduledTaskOptions()` | Returns models, engine-derived default effort options, saved projects, and an optional read error. It accepts no authored payload and is independent of schedule polling. |
| `window.catcode.scheduledTask(command)` | Returns `{ ok: true, snapshot }` after success or `{ ok: false, error }` after refusal. It accepts `save`, `pause`, `resume`, `delete`, `run`, and `workspace-maps`. |

`app/shared/scheduledTasks.ts` owns the command and snapshot types. A new `save`
needs a `workspaceId` minted by main for an existing saved project or a single-use
`cwdToken` from the existing native folder picker. An edit can omit both to
retain its saved project. It cannot supply a raw filesystem path. Required
fields include name, prompt, schedule, enabled, model (empty means default),
effort, and default/auto permission mode. The workspace-map command accepts a
project handle or native picker token (exactly one) and creates a paused preset.

### Session-independent options amendment (2026-10-13)

The disposable `scheduled-options` worker uses observation-only
`bootstrapWorkerEngine`, not session initialization or account-pool startup.
It reads `getModelOptions(false)` while provider switching is unlocked, and derives
each selection's effort capabilities through the engine's model resolver and
`getSupportedEffortLevels`. Default effort options resolve the engine default;
read errors are explicit, never a fabricated Default-only catalog. The supported
saved effort union includes `ultra`, carried through existing string spawn controls.

Projects come exclusively from `getGlobalConfig().projects`, not open chats,
registry entries or transcript history. Main canonicalizes existing directories,
deduplicates aliases and mints stable per-process opaque handles. Saving or creating
a preset revalidates the handle's canonical directory; renderer-authored paths
remain rejected. Closing or reaping chats does not invalidate project handles.
Edits may omit a source to retain their saved directory. The native picker with
no active session has no chat-derived default directory.

Options reads are single-flight, bounded to one validated NDJSON record and a
15-second worker lifetime with kill escalation. Request/result parsers are closed;
the main receiving method accepts only an undefined payload from the main window.
No project hooks, project bootstrap, live model request or real schedule is needed
to discover options. This adds a host-only read contract, not a session wire shape.

Each run's `appSessionId` identifies its ordinary chat. Existing host session
and restore APIs own opening those chats; their permissions and pending
questions remain on the normal conversation surface.

## Validation

The requested review used separate core and integration batches, then a
cross-boundary and prompt-scenario pass. It fixed duplicate store ownership,
DST catch-up, pending-request status, definite admission refusal, durable chat
identity, explicit close/restart tracking, malformed input/state handling,
atomic legacy import, shell path quoting, and two weak regression assertions.
The interface was added later; see Desktop interface.

Core regressions exercise real durable files and a second process competing for
ownership. Process tests compose the real host, registry, Unix-socket supervisor,
receiving sidecar boundary and session controller with a fixture turn. They
exercise parallel permission requests, untrusted refusal, nine simultaneous due
tasks, explicit close, failed registry publication and child-observed controls.
Child-isolated migration tests inject a partial write and execute the prompt's
path argument through the shell. New behavioral cases failed against the broken
code, and ten isolated mutations failed the strengthened tests as intended.

An isolated acceptance probe copied the real matching legacy cursor byte for
byte. The real helper accepted the native state for an incremental review; the
probe blocked only its own temporary run, left the cursor unchanged and changed
no maps or original state.

Desktop typecheck, scoped sidecar typecheck, main/preload bundles, map lint and
diff checks passed. The sidecar wrapper ignored 5,574 upstream diagnostics under
its existing scope. The clean temporary desktop suite had 5,890 passes, three
skips and one failure across 5,894 tests in 404 files. The failure is
`app/shared/sessionRelocationRepeat.storage.test.ts:137`, already reproduced
against committed baseline `c90fb49d` before this implementation. All scheduling
and preload cases passed. The temporary snapshot excluded unrelated shared-tree
edits and ignored archived test copies.

Actual Electron IPC/lifetime acceptance, live provider initialization and real
transcript restore were not executed. Explicit restart integration is source,
typecheck and bundle verified; explicit close is process verified. Autonomous
map review/cursor advancement still requires a real authorized turn. The installed
application and existing external schedule were not changed.
