# Native scheduled tasks

Date: 2026-10-13. The user requested recurring work in Cat Code so workspace-map
maintenance no longer needs ChatGPT scheduling. Exact reference-product parity
is not required.

## Ownership and scope

`app/host/scheduledTasks.ts` owns durable task definitions, individual run claims,
and lifecycle tracking. Electron main starts and stops it with the existing host.
The Scheduled page uses two fixed preload methods; main validates closed inputs.
Workspace identity comes from an existing host-owned project session or a
single-use native picker token. Renderer-authored filesystem paths, resume
identities, permission rules, and bypass mode are rejected.

Each run creates an ordinary session through `Host.createSession`, waits for
socket readiness through `launchScheduledSession`, and submits through the
existing `app.submit` receiving boundary. It uses the real engine, workspace
trust, tools, permission requests, transcripts, and normal session lifecycle.
Model, effort, and default/auto permission mode use the existing spawn controls.
No sidecar wire kinds, engine permissions, or locked process topology change.

The first version supports independent runs, daily/weekday/weekly wall-clock
times in a saved timezone, and minute intervals. Runs continue with the Scheduled
page closed while a Cat Code window and its host remain open. Closing the last
window stops scheduling under the existing desktop lifetime contract. It does
not install an OS daemon, wake a sleeping computer, or execute in the cloud.

## Durable dispatch and results

The single-instance desktop host owns
`<Cat Code config home>/desktop/scheduled-tasks.json`. Writes use a private
temporary file, file sync, rename, and directory sync. A read failure preserves
the existing document and leaves scheduling unavailable. A failed write freezes
dispatch rather than allowing execution whose claim was not saved.

A run's stable chat identity and dispatch claim reach disk before creating its
engine process. A task can have one unfinished run. Overdue recurring work runs
once and moves the next occurrence into the future; missed occurrences are not
replayed. Recurring tasks persist until paused or deleted and do not inherit
terminal cron's seven-day expiry. Run now works for paused tasks and leaves the
next scheduled time alone. Pause and delete affect future dispatches; they do
not abort an already claimed run. Deleting a task keeps its run chats and history.

Readiness, prompt delivery, permission waits, and turn results remain distinct.
An SDK result alone does not finish the run: completion also waits for the real
controller's inactive-turn event. Replayed history cannot complete a live run.
An unfinished run after host restart becomes interrupted and is not resubmitted.
The user can inspect or continue its saved chat. A failed launch/refused prompt
is recorded and not automatically redelivered. These rules avoid pretending
exactly-once execution across an uncertain crash boundary.

Finished means the agent turn ended successfully, not that its requested work
was semantically successful. The final report remains available in the chat and
as a bounded run summary. A permission or question request displays Needs
attention and keeps the task unfinished. The store retains 200 recent runs,
including every unfinished run, and at most 50 definitions.

## Workspace-map migration

Add workspace-map task creates a paused daily 03:00 Asia/Bangkok task for the
selected project. The preset requires that project's existing refresh helper.
Its prompt uses the helper's start, review, check, finish, block, and recovery
contract, explicit map paths, scoped commits, committed source, and preserved
unrelated work.

State belongs to
`<Cat Code config home>/desktop/workspace-map-refresh/<workspace hash>`.
On explicit preset creation, a matching legacy Codex helper state is copied
once without changing its bytes or the old state. Active review/commit states
are refused. Later scheduled runs use only Cat Code state. The preset remains
usable without any legacy state and will perform the helper's baseline review.

Pause the previous external schedule before enabling this task to keep one
refresh owner. Creating the feature or preset does not edit external scheduling
definitions, start a live model turn, or install a new application build.

## Validation

The scheduler tests cover durable claims, restart, overlap, catch-up, failures,
permission waits, replay suppression, turn closure, and timezone/DST behavior.
A process test composes the real host, registry, Unix-socket supervisor,
receiving sidecar boundary, and session controller against an isolated fixture
turn. It proves both permission waiting and untrusted-workspace refusal without
account access or model requests. A DOM test checks selected project identity
and preservation of the draft after a rejected save.

Verified for this change: 24 focused scheduling/preload tests, desktop typecheck,
scoped sidecar typecheck, renderer build, map lint, and diff checks. The full
desktop suite in a clean temporary snapshot had 5,883 passes, three skips, and
one failure in `app/shared/sessionRelocationRepeat.storage.test.ts:137`. That
same failure reproduced against committed baseline `c90fb49d` before applying
this change. The shared-tree suite also discovered an incomplete archived test
copy under `tmp/`; the clean snapshot excluded that unrelated artifact.

Live provider execution and native GUI acceptance were not run. The installed
application and the existing external workspace-map schedule were not changed.
