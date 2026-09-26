# No-project chats: adversarial design review

Date: 2026-09-26. Reviewed design commit: `ff3a5db7`.
Scope: design and source inspection only. No application implementation.

Two independent subagents reviewed the completed proposal in parallel:

- `design_omissions` looked for missing requirements, lifecycle cases, and
  integration work. It returned three findings.
- `design_challenges` challenged the proposed decisions and factual claims.
  It returned four findings.

The reviewers worked read-only, using the proposal, mockup, repository source,
and architecture decisions. Their seven findings overlap in two places, leaving
five distinct issues. The parent checked the cited source and accepted all five.
The corrections are incorporated in the [revised design](../design/2026-09-26-no-project-chats.md)
and, where visible, the [mockup](../design-html/2026-09-26-no-project-chats.html).

## Accepted findings

### 1. Working files under `.cat-code` trigger sensitive-directory checks

Reported by both reviewers. The original layout put each chat's working files
under `~/.cat-code/chats/`. In
[`filesystem.ts`](../../src/utils/permissions/filesystem.ts),
`DANGEROUS_DIRECTORIES` includes `.cat-code`, and `checkFileEditPermissions`
performs path safety checks before allowing ordinary cwd edits in acceptEdits
mode. Even `report.md` would inherit the sensitive ancestor.

**Correction:** put working files under an app-data directory outside the
protected configuration tree. Keep host binding records in config home.
Record the canonical root in a stable workspace binding. No new permission
exception is proposed, and sensitive descendants retain their existing checks.

### 2. Logical peer membership alone breaks ReadPeer

Reported by both reviewers. Changing `peersOf` to include all managed chats
does not make their transcripts readable. In
[`readPeerTool.ts`](../../app/sidecar/readPeerTool.ts), `readerProjectDir`
derives the transcript directory from the reader's launch cwd. Once A and B
have separate working directories, reading B by its engine ID searches A's
transcript directory and can falsely report that nothing has been written.

**Correction:** return the target's pinned transcript storage identity in
host-validated peer metadata. Resolve it under the configured transcript store
inside the reader's sidecar. Preserve passive reads, bounds, redaction, and
untrusted-data framing. An unresolved locator returns unavailable. No transcript
contents travel through main and no model supplies a filesystem path.

The proposal now explicitly calls for amending
[R9](../migration/decisions/PEER-SESSIONS.md) and
[HR3/HR6](../migration/decisions/HOST-REQUEST-PLANE.md) alongside the metadata
contract. Existing approved decisions and runtime behavior remain unchanged
until implementation is separately requested.

### 3. An artifact in a peer's cwd cannot open from the presenting chat

Reported by `design_challenges`. The original statement that file links could
remain unchanged omitted the different working directories. In
[`openWorkspaceFile.ts`](../../app/main/openWorkspaceFile.ts), the canonical
target must lie inside the displaying session's cwd. A link from A to B's output
therefore fails even if the handoff itself was authorized.

**Correction:** deliver a copy into the presenting chat's cwd, or have the peer
write to an explicitly agreed destination there under normal permissions.
Preserve originals and disambiguate filename collisions. When a file should
remain with its peer, open the owning chat and use that chat's Files action.
External destinations get truthful copy-path presentation. This preserves the
existing opener's containment check and avoids a new cross-chat file service.

### 4. Project switching conflicts with session-bound attachments

Reported by `design_omissions`. The original project selector remained editable
until first Send, but adding an attachment could already create a session.
In [`mainDecisions.ts`](../../app/main/mainDecisions.ts),
`createAttachmentFileTokenStore` binds native-picker tokens to a session ID;
resolving the same token for another session returns undefined. The proposal did
not define a transfer or rebinding contract.

**Correction:** New chat immediately creates a normal managed session with a
fixed No project context. Starting a project chat is a separate action. Existing
per-session drafts, attachment lifetime, model controls, and engine startup
apply. No pre-session composer or attachment-transfer mechanism is introduced.
The mockup now shows a read-only label and Files access in the empty chat.

### 5. The claimed existing branch confirmation does not exist

Reported by `design_challenges`. The proposal suggested putting the shared-files
warning in an existing confirmation. The branch message action in
[`App.tsx`](../../app/renderer/src/App.tsx) directly sends
`session.branchFromMessage`; that confirmation is not an available surface.

**Correction:** specify a new non-blocking notice above the branched chat's
composer: “Files are shared with the source chat.” Keep conversation-only
branching and shared storage identity. The mockup includes a Branch state with
the notice. No confirmation dialog is added.

## Additional source correction

During reconciliation, the parent found that the proposal overclaimed the
ordinary submit persistence contract. `SubmitResultFrame` in
[`protocol.ts`](../../app/shared/protocol.ts) reports whether a turn started
or a prompt was staged. It is not a durable-save receipt, and the engine's
`onInputPersisted` callback is not an ordinary renderer submit receipt.

The revised design persists the managed binding before sidecar spawn, then
reuses the existing correlated submit/recovery flow. It does not promise
exactly-once delivery across crashes or automatically resend after an uncertain
transport outcome. A durable receipt protocol would be separate work.

## Revision validation

- `git diff --check`: passed.
- `bun run maps:lint`: passed with seven existing recommended-section warnings
  in maps untouched by this task.
- All local Markdown links across the design and this record resolved at review
  time (40 links in revision `f3156ad3`).
  The mockup's local font and image paths resolve; it contains no remote URLs.
- Extracted inline JavaScript passed `node --check`.
- Browser verification on the isolated local preview covered New chat, sample
  submit/File task, Two chats, Branch, and Missing files/recreate. Also checked
  the empty-chat Files menu, Escape dismissal, project creation entry point and
  its folder menu, and sidebar search.
- Visually inspected the revised empty and branch states. The branch notice is
  visible above the composer; No project is read-only; Files is available in
  the empty chat. The local image loaded, no design-chrome classes were inside
  the specimen, and no new browser warnings or errors were observed.

State selectors reset the sample. Native attachment, Finder, clipboard, and
engine operations remain outside this mockup. No application build, runtime
test, or Cat Code GUI session was run. This review does not establish runtime
correctness: permission behavior, peer transcript location, attachment lifetime,
and restore cases remain acceptance criteria for a future implementation.
