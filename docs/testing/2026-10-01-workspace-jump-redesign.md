# Workspace jump redesign verification

The approved reference is `docs/design-html/2026-10-01-workspace-jump-redesign.html`:
PROPOSED states, Arrival motion D, Arrived label D. The browser tool blocked its
local file URL, so this implementation used the HTML/CSS source. Open the file
locally in a browser for the visual comparison.

## Automated boundaries

- `app/host/workspaceMoveDisplay.test.ts`: accepted target provenance, bounded
  metadata, stopped versus failed, destination arrival despite uncertain or
  cancelled continuation, and a later manual context owning its own seam.
- `app/host/host.test.ts`: the validated manual destination is published while
  moving; a refused relocation keeps the display identity and settles as failed.
  Existing process/relocation tests cover the unchanged transport and recovery.
- `app/renderer/src/TranscriptView.dom.test.tsx`: hidden workspace tool cards,
  stable divider DOM and position, no duplicate seam before readiness, one arrival
  wash, no replay after an empty-chat remount, rerender or
  restored mount, reduced motion, Chat copy without a folder or path, and
  replacement of the host-named terminal notice while uncertain notices remain.
- `app/renderer/src/App.dom.test.tsx`: the mounted conversation, draft, image,
  composer and empty-chat welcome survive delayed relocation replay. The moving
  composer retains the normal placeholder.

## Operator checks in Cat Code Dev

No GUI launch or driving was performed by the implementing agent. These steps
are for the operator. They use real app state; choose a disposable conversation
and an already trusted scratch project.

1. From the repository root, launch `bun run --cwd app dev`. Wait for
   `[main] renderer ready`, and use the window identified as **Cat Code Dev**.
2. On Home, create a managed Chat with **New chat**. For the manual check, use
   its session actions menu's **Move to project** and select the trusted scratch
   project. This can be an empty Chat and consumes no model request.
3. Watch for one centered divider with a pulsing accent dot, “Moving to”, the
   folder name and a muted mono path. The composer should keep its normal
   placeholder, dimmed. Its draft and attachments should remain intact.
4. On arrival, that same divider should show the project-coloured folder,
   “Working in” and the project name, followed by **Move back**. The path and
   moving dot disappear. A wash covers the divider and content below it, then
   fades out over roughly 1.8 seconds. The rules cool to seam colour; the folder
   retains project colour. There should be no blue status box.
5. Click **Move back**. Expect “Moving to Chat” then “Working in Chat”, without
   a folder icon or path. Repeat a manual move to verify the next arrival plays
   once and older seams stay in their transcript positions.
6. For the agent path, create another managed Chat, select the desired model in
   the composer, and send a request naming a known trusted project, such as
   “What is cat-code?” when that project is available. Expect no ListWorkspaces
   or JumpWorkspace card. No new divider is required before host acceptance.
   After acceptance, check the same states and motion as the manual path.
7. For Stop, click the existing Stop control while the agent jump is still
   pending and before relocation commits. An accepted, cancelled operation
   should settle to “Stopped moving to <project>”, with no icon or warning
   colour. Stopping before acceptance can produce no new divider. Manual
   relocation has no independent stopped signal or added cancellation control.
8. Close and reopen the disposable conversation, and reload the renderer.
   Arrival seams must remain at rest. Switching tabs, receiving more text or
   editing the composer must not restart the wash.
9. Enable macOS **System Settings → Accessibility → Display → Reduce motion**
   and repeat the manual move. Expect the resting arrived state immediately,
   without the wash or rule animation. Restore your preferred setting afterward.
10. Compare dark and light appearance, the relevant accent preferences and a
    narrow window. Check long paths truncate within the divider, Move back has
    a visible keyboard focus ring, and the neutral text remains readable.

Failed accepted moves are covered automatically. A naturally occurring manual
failure should update the same divider to “Could not move to <destination>”;
existing actionable error handling remains available. No fault injection is required in live conversations.

## Signal coverage and persistence

Main sources agent targets from its accepted ledger and manual targets from the
host's validated location. The renderer never resolves an agent handle and sends
no new message kind. Accepted/requested and moving share the moving label.
Durable destination location wins over continuation outcome for the arrived
label; uncertain continuation keeps the existing explanatory notice.

Completed moves retain their existing persisted context transitions. Retained
failed/stopped agent operations reconstruct display metadata from the existing
ledger. Manual failure metadata lasts for the host session and adds no new
persistence or recovery contract. Pre-acceptance refusals retain existing error
handling and have no new divider.

## Verification results

The focused host/coordinator/renderer/composer/text checks passed all 445 tests.
The renderer typecheck, scoped sidecar typecheck, renderer build, map lint and
`git diff --check` passed. The full `bun test app/` run required an unsandboxed
retry for isolated local Unix sockets. That run reported 5,240 passing tests,
three skips, five stale test expectations and one loading error from an old
ignored test copy under `tmp/`. The five expectations also fail with committed
App and SessionPane sources in an isolated baseline check: three App source
tripwires, one MemoryPage empty-state string, and one PermissionRulesEditor
unread-settings string. They were not changed as part of this redesign.

Live motion, appearance and width checks remain operator verification.
