# Peer `Announce`: a standing scope notice on the roster

**Status: DESIGNED 2026-10-17 with the operator; not built.** Desktop app only.
Extends [PEER-SESSIONS](../migration/decisions/PEER-SESSIONS.md) and replaces
its deferred "file-overlap visibility" item (§12), which the operator withdrew
the same day. Source anchors were checked on 2026-10-17; source wins on conflict.

## 1. Problem

Sessions that share this tree ask each other what they are doing before they
edit. The question costs a message, often wakes or interrupts the peer, and
the answer is usually one line the peer could have published once.

Evidence: the openings of every `SendToPeer` call in this workspace's
transcripts (`~/.cat-code/projects/-Users-pt-cat-code/*.jsonl`, read
2026-10-17; 273 unique messages across 78 transcripts). The recurring asks:

- **Which files or surfaces a peer owns or is editing.** "Please tell me which
  files/surfaces you own or are actively editing". One session sent the same
  "list paths so I can avoid overlap" question to three peers before starting.
- **Whether a peer is editing at all.** Several answers were only "read-only
  analysis, no edits", which would have settled the question unasked.
- **Whose edits these are.** "Are those yours or a worker's?" A session's
  subagents edit too, and nothing shows that they belong to it.
- **The title as a stand-in.** "Your session title overlaps." A title says
  what a chat is about, not what it will touch.

A fifth kind, "I'm staging now, hold the index until I send the SHA", is a
seconds-long lock on the shared git index, not scope. It is out of this
design (§7).

**Goal (operator):** a peer's scope is readable from `ListPeers`, so the
question is not sent.

## 2. Operator rulings (2026-10-17)

| # | Ruling | Consequence |
|---|---|---|
| A1 | The agent writes the notice with its own tool, when it judges it useful or roughly knows what it will touch. | `Announce` is a new peer tool. No session is required to post one. |
| A2 | Others read it when they list sessions. | The notice is a field on the writer's `ListPeers` row. Posting wakes, notifies or messages no one. |
| A3 | Do not make the shape too strict; agents may write what the fields do not anticipate. | A free-form `note` field beside the two named ones. |
| A4 | Name the area (folder or system), not a required file list. | `touches` takes areas, and files where the agent knows them. |
| A5 | The agent should not spend attention keeping it current. | Scope, not status: written once, rewritten only when scope changes. Transient states never go in it. |
| A6 | File-overlap visibility is no longer needed. | Withdrawn from PEER-SESSIONS §12. No automatic edit tracking. |

## 3. Shape

One notice per session. A call replaces the previous notice whole; there is
no history and no append.

**One writer per session: the conversational agent.** It posts the aggregate
notice, including the areas its subagents will edit. Workers can inherit the
parent's tools and its desktop prompt addendum (`runAgent.ts` passes
`appendSystemPrompt` through), and `Announce` is not in
`ALL_AGENT_DISALLOWED_TOOLS`. Main attributes every write by connection, so it
cannot tell a worker from its parent. A worker following the doctrine would
therefore replace the parent's notice with its own narrow slice, and two
workers would overwrite each other. The tool refuses any call with
`context.agentId` set, before it reaches main, the way `ListWorkspaces` and
`JumpWorkspace` do in `app/sidecar/workspaceJumpTools.ts`.

| field | required | content |
|---|---|---|
| `doing` | yes | One line: the goal, and whether the session is editing files or only reading. |
| `touches` | no | Areas the session expects to work in (folders, subsystems), plus any shared file it knows it will edit. Includes its own subagents' edits. |
| `note` | no | Standing context that stays true for the whole task. |

Examples of the intended content:

- `doing`: "Retiring Agent Mode across engine, desktop and prompts. Editing."
- `doing`: "Compaction latency analysis. Read-only, no edits or commits."
- `touches`: `app/renderer/src/composer/`, "peer tools in app/sidecar",
  `theme.css`, `app/main/main.ts`
- `note`: "The untracked PNGs in `generated-welcome-cats/` are mine; leave them."
- `note`: "The user asked me to own the composer redesign end to end."

**Why areas and files together.** A session knows its area when it starts and
its files only as it works, so a required file list would be guessed or
skipped (A4). But the collisions in the evidence were mostly NOT two sessions
in one area. They were sessions in different areas meeting at shared hub
files: `theme.css`, `app/main/main.ts`, `gpt.ts`, `docs/maps/web-app-runtime.md`.
So the guidance is: name your area, and name a shared file once you know you
will edit it.

**What never goes in it (A5).** Anything that will be false in minutes: a
branch switch, "committing now", "waiting on the user", progress. The roster
already carries the moving state without the agent's help: `presence`
(`running | needs_user | idle`) and last activity are on every live row
(PEER-SESSIONS §3). An event that affects a specific peer goes by
`SendToPeer`, or nowhere.

## 4. Where it appears

`ListPeers` renders the notice on the writer's row, with the absolute instant
it was posted. The instant is absolute for the reason PEER-SESSIONS §3 gives
for `asOf`: a rendered duration is correct once and decays while the result
sits in context. A reader judges a stale notice the same way it judges stale
`lastActivity`.

A row without a notice renders as today. Absence means "nothing posted", not
"touching nothing".

## 5. Lifetime and bounds

- **Held on main's registry row**, next to the fields `ListPeers` already
  reads. It survives park and restore, since a parked session's uncommitted
  work is still in the tree. It is dropped when the row is closed.
- **A per-notice size constant**, proposed `MAX_PEER_NOTICE_BYTES` = 1 KiB in
  `app/shared/limits.ts`, enforced at main and re-bounded in the sidecar, the
  way `MAX_PEER_TEXT_BYTES` is.
- **An aggregate budget for the roster's notices**, applied in main before
  serialization. The per-notice cap does not bound the answer: `peers.list`
  returns every eligible row as one `host.result`
  (`handlePeersList` in `app/main/peerRequestPlane.ts`), the closed-row bound
  is applied only after the answer reaches the sidecar
  (`boundClosedPeers` in `app/sidecar/listPeersTool.ts`), and the supervisor
  refuses a frame to the sidecar over `MAX_FRAME_BYTES` (128 KiB). Parked rows
  keep their notices and are bounded only by `MAX_REGISTRY_SESSIONS` (256), so
  128 rows with full notices already pass the frame limit. A fixed notice
  total is not safe either: measured 2026-10-17, 255 typical rows with no
  notices serialize to about 98 KB, so 32 KiB of notices on top passes the
  limit. The budget is therefore on the whole answer. Main serializes the
  rows first, then adds notices newest-posted first while the answer stays
  under `MAX_PEER_ROSTER_BYTES` (proposed: `MAX_FRAME_BYTES` minus envelope
  headroom), and marks each row whose notice did not fit `noticeOmitted`.
  Every row is still listed; only notice text is dropped, and
  `ListPeers` says which peers' notices were left out, so a reader can message
  the peer rather than read silence as "no notice". The budget is also the
  roster-cost bound: every `ListPeers` call carries the notices into the
  caller's context, and the cost of an unbounded roster was measured once
  already (`CLOSED_PEERS_SHOWN` in `app/sidecar/listPeersTool.ts`).
  `MAX_FRAME_BYTES` is the sidecar's inbound security limit and is not raised.
- **Precondition, found while sizing this: the roster overflows today.** The
  same measurement with 255 rows whose titles are at `MAX_SESSION_TITLE_CHARS`
  (200) gives about 135 KB of ASCII, or 186 KB with two-byte characters, and
  no notices at all. A long-lived workspace near the registry bound can
  therefore already produce a `peers.list` answer the supervisor refuses.
  That is a `ListPeers` defect independent of `Announce`, and its fix (for
  example, applying the closed-row bound in main instead of the sidecar)
  should land first, so the notice budget above always has room to work in.
- **No new rate limiter.** Writes ride the request plane's existing bound
  (HOST-REQUEST-PLANE HR1).
- **Desktop only**, like every peer tool. Terminal sessions never have a
  registry row and never appear (PEER-SESSIONS §3).

## 6. Boundaries and trust

**HR6 holds unchanged.** HOST-REQUEST-PLANE HR6 says "Main never receives a
path." Main already relays `SendToPeer` text that may name any file, because
it treats that text as opaque. The notice is handled the same way: main
stores it and returns it verbatim, and never parses `touches` as paths,
resolves them, or compares them between sessions. An automatic overlap check
would need main to do exactly that, which is one more reason it stays out
(A6).

**Inbound validation.** The new request verb gets a closed schema at main:
known fields only, `doing` non-empty, every field inside the size constant,
`touches` a bounded array of strings. Invalid input is refused, not trimmed.
`app/shared/protocol.ts` versioning applies (CLAUDE.md §6), with tests that
accept valid and reject invalid notices.

**Permission.** No permission prompt. Posting changes nothing until another
session reads it, and a prompt would teach agents to skip the tool. The tool
projects its full notice for the auto-mode classifier, as `SendToPeer`
projects its text, because it carries model-authored text to other sessions
(PEER-SESSIONS §4 on projections).

**Reader side.** A notice is the peer's own statement, with the same trust as
a peer message. `ListPeers` serializes it as quoted data and neutralizes
control text in it, as `ReadPeer` does for transcript entries
(PEER-SESSIONS §8).

## 7. Out of scope

- **Automatic file tracking and overlap warnings.** Withdrawn (A6).
- **Blocking or enforcement.** The board informs; it never refuses an edit.
- **Index or commit locks.** A seconds-long coordination event, not scope.
  A notice that outlives the commit would mislead.
- **Push on change.** Posting or replacing a notice notifies no one (A2).
- **Terminal sessions.** Follows the terminal-out ruling.

## 8. Proposed prompt text

Desktop-only, so it lives with the other peer prompt surfaces
(`app/sidecar/desktopSystemPrompt.ts` and the peer tool files; see
`docs/maps/prompt-system.md`). User-visible text rules apply (CLAUDE.md §7:
no em dashes). The build may adjust wording; the behavior is the contract.

Doctrine addition, appended to the peer paragraph:

```text
When you know roughly what you will work on, especially before you edit files,
post a notice with Announce: what you are doing, and the areas or shared files
you expect to touch. Replace it only if your scope changes; it is not for
progress or momentary state. Include work you hand to subagents; only you
post the notice. Before asking a peer what it is doing or which files it is
editing, read its notice in ListPeers. Ask about its scope only when your
scope overlaps its notice, or it has no notice and you are about to edit near
its work.
```

The last sentence narrows scope questions only. It does not narrow the
existing reasons to message a peer in the `SendToPeer` prompt
(`app/sidecar/sendToPeerTool.ts`): needing something only that peer knows,
finishing something it is waiting on, or being about to touch something it is
working on. A notice replaces "which files are you editing?", not report-back
or answers.

`Announce` tool description:

```text
Post or replace your notice on the peer roster. Other sessions in this
workspace see it when they call ListPeers; posting notifies no one. Describe
your scope, not your progress: post it once you know what you will work on,
and replace it only if that changes. Only the main conversational agent may
call this tool; subagents report their scope to it instead.
```

Field descriptions:

```text
doing: One line: what you are working on, and whether you are editing files or only reading.
touches: Areas you expect to work in, such as folders or subsystems, plus any shared file you know you will edit. Include files your subagents edit.
note: Anything else that stays true for this whole task and that a peer working nearby should know.
```

`ListPeers` description addition:

```text
A peer's notice is its own statement of scope as of the time shown. A peer
marked as having a notice left out has one that did not fit in this list;
message it if you need its scope.
```

## 9. Build sketch

0. Fix the existing roster overflow (§5 precondition) as its own change.
1. `app/shared/limits.ts`: `MAX_PEER_NOTICE_BYTES` and
   `MAX_PEER_ROSTER_BYTES`. `app/shared/protocol.ts`: the request verb,
   and an optional `notice` and `noticeOmitted` on `PeerDescriptor`, with a
   version bump if the wire shape requires one.
2. `app/host/registry.ts`: the notice on the row, cleared on close, persisted
   with the row. Main handler with the closed schema; `handlePeersList`
   applies the aggregate budget. Boundary tests, including a full roster
   (`MAX_REGISTRY_SESSIONS` eligible rows, every notice at the per-notice cap,
   with posted times) that serializes under `MAX_FRAME_BYTES` and marks the
   rows past the budget.
3. `app/sidecar/announceTool.ts`, built through `buildTool` like
   `listPeersTool.ts`, appended in `sessionController.ts` beside the other peer
   tools, with its classifier projection and the `context.agentId` refusal
   (§3). Test that a worker call is refused and the session's notice is
   unchanged.
4. `app/sidecar/listPeersTool.ts`: render the notice and its posted time as
   quoted data.
5. Doctrine and tool text (§8), then update the prompt-system map row and
   PEER-SESSIONS §4 and §5 to the built text.
6. Live check in Cat Code Dev: one session posts, a second lists and sees the
   notice, the first parks and the notice is still listed, closing drops it.

## 10. How to tell it worked

Repeat the §1 read a few weeks after it ships. The scope questions ("which
files", "are you editing", "yours or a worker's") should mostly be gone, and
the messages that remain should name a specific overlap. If notices are
missing or stale in the sessions that still collide, revisit the prompt text
before adding any mechanism.
