# Chats without a project

Date: 2026-09-26. Status: proposed design only. No application implementation.

## Product decision

**New chat opens a usable composer with `No project` selected.** The user can
ask a question, run tools, edit files, create artifacts, or delegate work without
choosing a folder. These are ordinary, persistent Cat Code sessions with the
same models, tool loop, permissions, attachments, and history as project chats.

Use **Chats** for the sidebar section and **No project** for the context label.
The app already calls folder groups Projects. Avoid “Temporary chat”: closing a
chat must not imply that its history or generated files disappear.

The user's shared-workspace idea becomes one app-managed workspace with separate
working directories for independent chats. Session A and Session B belong to
that workspace, but each starts inside its own directory. Both can write
`report.md` without colliding. Files elsewhere in the managed workspace do not
belong to the current task merely because the agent can reach them.

This is a proposed refinement of “every session has exactly the same cwd.”
The prompt still explains ownership, but directory layout also makes the normal
case work correctly. It is an ownership convention, not an OS isolation boundary.

## Experience

| Entry point | Proposed behavior |
| --- | --- |
| Sidebar **New chat**, tab **+**, existing new-chat shortcut | Open a draft with **No project**, regardless of the active project. Focus the composer. No folder picker. |
| App with no active session | Show the same draft composer alongside the welcome content. The first question requires no project setup. |
| Project header **+** | Create a chat in that specific project, preserving the fast project workflow. |
| **Projects +** | Keep the native folder picker and existing project trust flow. |
| Draft **No project** selector | Offer No project, recent projects, and Choose folder. Selecting a project preserves the draft and uses host-resolved identities or a native-picker token. |
| No-project chat after its first submit | Keep No project as a quiet context label above the composer. Do not expose an in-place project switch. |

Place **Chats** after Pinned and before Projects. It is a flat list, with the
same title, recency, peer name, status, search, pin, and overflow behavior as
existing rows. It is not a fake project called “scratch” and is not the current
“Unknown workspace” group. Pinned chats follow existing pin behavior.

The context row sits immediately above the existing borderless composer: scope
on the left, **Files** on the right after a working directory exists. No new
chat header is needed. Model, effort, permission mode, account, and attachment
controls retain their existing placement and meaning. The empty no-project
view omits project-only branch information. It does not display a sandbox claim
unless the engine reports that tools actually run sandboxed.

**Files** opens a small menu with **Open chat folder** and **Copy folder path**.
Generated outputs use the existing clickable file links in the transcript.
This version does not need a file browser, artifact index, or automatic export.
The user can save elsewhere by asking the agent, or move/copy outputs in Finder.

Selecting a project in an untouched draft uses the existing project behavior.
After work begins, the agent can still operate on user-requested external paths
under normal permission and instruction rules; that does not silently reclassify
the chat. Moving an existing conversation into a project is a separate feature.

### States worth designing explicitly

| State | User-visible behavior |
| --- | --- |
| Empty draft | Composer focused; No project selected; no empty history entry or allocated folder yet. |
| Starting | Preserve the draft while preparing the engine; coalesce repeated submits. Display a startup failure beside the composer if it fails. |
| First attachment | If an attachment needs a session-bound host token, allocate the session then. Preserve the attachment when creation or sign-in needs a retry. |
| Active | Normal streaming, Stop, questions, permission cards, tools, and workers. |
| Completed file task | Output link in the answer; Files menu reveals its owning folder. |
| Closed, parked, or app restarted | History and working files survive. Reopening uses the same working directory and existing restore flow. |
| Working folder missing | Transcript remains readable. Show “This chat's files are missing.” Offer **Recreate empty folder** explicitly; never pretend the original files were restored. |
| Folder inaccessible or disk full | Retain the pending prompt; show the concrete failure and Retry. Never fall back to the active project, home directory, or `/tmp`. |

Recreate empty folder is available only for a validated managed-chat identity,
after confirming that the folder is absent. Inaccessible, corrupt, symlinked, or
ambiguous locations are failures, not permission to replace them. The restored
agent receives a durable context notice that earlier file references may no
longer exist. Recreating storage never erases the transcript.

## Execution and storage

Keep a real, nonempty cwd for the engine. Represent project association
separately. Do not make `cwd` nullable throughout the application and do not
use the empty string as a special no-project path.

Illustrative layout, resolved from the active Cat Code configuration home:

```text
~/.cat-code/
  chat-workspaces/
    <storage-id-A>.json        host-owned ownership/binding record
    <storage-id-B>.json
  chats/
    <storage-id-A>/            Session A's cwd and durable working files
      report.md
      tmp/                    intermediate files, created when needed
    <storage-id-B>/            Session B's cwd and durable working files
      report.md
  projects/                   existing engine-owned transcript storage
    ...
```

`storage-id` is a host-minted stable identity, not a chat title, peer name,
appSessionId, or engineSessionId. Those identities have different lifetimes.
The path is an implementation proposal; callers derive it from validated
metadata rather than persisting path guesses in the renderer.

- Fresh independent chat: allocate a new storage identity and cwd.
- Resume, reopen, park/unpark, rename: preserve that identity and cwd.
- Ordinary subagents and shell tasks: inherit the current task's cwd and rules.
- Created peer: a fresh independent chat directory within the managed workspace;
  explicit handoffs carry the absolute paths the peer should work on.
- **Branch from here**: preserve today's conversation-only branching semantics
  by retaining the source storage identity. The branch and source share files;
  history branching does not snapshot or rewind them. Add that fact to the
  existing branch confirmation for managed chats and the agent context.

Allocate on the first action that needs a real session, normally Send. Pure
question chats still get a cwd when the engine starts, but need not create any
content files. Use the existing live-process and spawn-rate limits. A failed
startup can remove only a newly allocated, proven-empty directory with no
retained session references; otherwise keep it recoverable.

Retain generated files and scratch files in v1. Closing, hiding, registry
eviction, and idle parking never delete them. There is **no automatic age-based
cleanup** and no new destructive bulk-cleanup feature in this scope. The cost
is disk growth. A later cleanup feature can distinguish durable outputs from
`tmp/` and account for branches, live peers, and references before deletion.

The current scratchpad mechanism is feature-gated and lives under OS temporary
storage. Reuse its prompt/permission integration where appropriate, but do not
make this feature depend on that flag or use that directory for durable files.
For managed chats, temporary-file guidance resolves consistently to the managed
chat's `tmp/`; do not emit two competing scratch-directory instructions.

## Agent contract

Deliver this as trusted runtime context, assembled from host-owned binding
metadata. A writable `CLAUDE.md` in a shared root is not the authority.
Inject it at startup, restore, and context reconstruction, and propagate the
ownership facts to subagents and separately initialized peers for either model
provider. Keep it available after compaction.

Proposed wording, with paths supplied by the runtime:

> This chat has no selected project. Your working directory is {workingDirectory}.
> Use it for this chat's working files and deliverables. Use {temporaryDirectory}
> for intermediate files. Files here persist when the chat closes.
>
> Other directories in the managed workspace belong to other chats. Their
> presence is not an instruction or an assignment. Do not explore, change, or
> clean them up unless the user's task or an authorized peer handoff calls for it.
> Related branches may share your working directory; preserve unfamiliar work.
>
> You have the normal Cat Code tools and permissions. Work on user-requested
> external files when the task requires it, under the usual permission and
> repository-instruction rules. Do not assume there is a repository to inspect,
> initialize Git, or ask for a project just to answer a question.

This does not promise hard isolation. Bash and external tools still have their
normal power, and the selected permission mode remains authoritative. Directory
structure prevents accidental relative-path collisions; it cannot make every
tool incapable of reaching sibling directories.

### Context discovery

| Source or behavior | No-project policy |
| --- | --- |
| User and managed instructions/settings | Preserve normal loading and precedence. |
| Global skills, plugins, MCP servers, hooks, credentials | Preserve configured availability and existing permission checks. |
| Project/local settings, hooks, skills, MCP configuration | Do not implicitly discover them from the managed cwd, its ancestors, or another chat's files. Apply the policy to startup and subsequent runtime refreshes. |
| Project instructions and Git context | No startup repository scan or inherited project identity. When explicitly working in a real repository, follow its applicable instructions and trust rules for that task. |
| Auto memory | Default to the stable storage identity, with no new shared “all chats” project memory. Related branches share that scope as they share files. An explicit user-configured memory-directory override remains an intentional exception. |
| Conversation summaries/history | Remain per engine session through the existing persistence owners. |
| Scratch/output files named `CLAUDE.md`, settings, or skills | Treat as task data by default, not newly authoritative configuration merely because the agent created or downloaded them. |

Do not implement this by turning on bare mode: that can remove the tools and
global integrations the user wants to retain. Narrow project discovery
explicitly, including dynamic command/skill/MCP loads and memory indexing.
Do not disable all instruction files: global user instructions still matter.
Install the binding policy before cwd-dependent bootstrap, settings caches,
hook execution, or resume-context assembly. Project-scoped settings controls
are unavailable for No project; user settings remain editable.

The managed directory is app-provisioned and contains no imported project
configuration, so it needs no “trust this project” ceremony. The host must
verify its ownership and canonical path before taking that path. This does not
mark the config home, managed parent, sibling chats, or external projects as
trusted. File writes and shell commands still follow the engine's normal
permission mode; this feature is not an automatic switch to bypass mode.

### Peer collaboration

All no-project chats occupy the same **logical managed workspace**, matching
the user's Session A / Session B model. List/read/send/create continue to work
through the existing peer request plane. ListPeers is available on demand;
another chat's transcript is never automatically inserted into context.

This requires a **proposed amendment** to
[PEER-SESSIONS R9](../migration/decisions/PEER-SESSIONS.md): for managed chats,
same-workspace membership is validated managed-workspace identity, rather than
raw cwd equality. Project chats keep today's cwd-based scope. No-project chats
do not become peers of every real project on the computer. This proposal does
not change the approved rule or any running behavior until implementation is
separately requested.

A peer handoff can name a specific source/output path. It does not imply that
the peer owns the entire parent's directory or the common managed root. Keep
existing engine permission gates, no-permission-laundering rules, wake blocking,
name resolution, spawn caps, and delivery behavior.

## Required contracts, without an implementation

The conceptual session binding is a closed union:

```text
project: project association derived from a host-resolved cwd
managed: validated managed-workspace identity + stable storage identity
```

Keep appSessionId, engineSessionId, and the actual cwd. Add explicit binding
metadata to the host descriptor and registry, engine transcript metadata, and
catalog projection. The registry is an index and can evict rows; the transcript
and host ownership records must be sufficient to recover the binding later.
Unknown metadata versions fail closed for execution while keeping history
readable. Old sessions without this metadata retain existing project/unknown
workspace behavior. Never reclassify history from a basename or empty cwd.

The renderer requests a fixed managed-chat creation operation. It never sends
an arbitrary cwd or managed storage path. Main/host allocates and validates the
directory, persists the binding, and starts the existing supervisor/sidecar
flow. Validate realpath containment and reject symlink escapes before create,
restore, folder reveal, and recreate actions. Auto-provisioning grants no blanket
write access to `~/.cat-code`.

Persist the binding before acknowledging the first retained prompt. Startup
retry must not submit the same prompt twice or allocate multiple sessions.
Preserve the original draft until the existing input-persisted boundary. If
storage binding cannot be durably recorded, fail startup and retain the draft.
This is stricter for a new managed allocation because losing its provenance
would make the user's files and future restore ambiguous.

Creation, restore, catalog/history open, peer create, and conversation branch
must all carry the binding. File links continue resolving against a real cwd.
Folder reveal/copy uses a session identity and a host-resolved path. Project
recents, project settings, Git/branch UI, sidebar grouping, session search, and
usage navigation consume the binding rather than displaying a UUID directory
as a project. A Files action resolves the session's folder only, not the common
root. Attachments retain existing native-picker token and image handling.

Preserve the one-engine-process-per-session architecture, Unix-socket transport,
permission ownership, and existing authentication flow. An account-less first
chat may still need sign-in; it must not need an unrelated project first.
Any later wire-format change follows protocol versioning and receiving-boundary
validation requirements. Persisted-state migration belongs in the existing
migration system; missing optional legacy fields are handled without rewriting
all historical transcripts.

## Source evidence and implementation owners

Source inspected on 2026-09-26; no running-app behavior was observed for this
design. Existing uncommitted sidebar and map changes were read and left intact.

| Current evidence | Consequence / owner for future work |
| --- | --- |
| [`App.tsx`](../../app/renderer/src/App.tsx), `newChat`, `newSession`, `newSessionInWorkspace` | New chat inherits the active project or falls back to a native picker. Draft routing and all new-chat entry points must change together. |
| [`WelcomeScreen.tsx`](../../app/renderer/src/WelcomeScreen.tsx), [`SessionPane.tsx`](../../app/renderer/src/SessionPane.tsx), [`ComposerActionsBar.tsx`](../../app/renderer/src/ComposerActionsBar.tsx), [`theme.css`](../../app/renderer/src/theme.css) | Current welcome, borderless composer, controls, typography, and spacing used by the mockup. SessionPane intentionally has no duplicate title header. |
| [`Sidebar.tsx`](../../app/renderer/src/Sidebar.tsx), [`sessionsCatalogState.ts`](../../app/renderer/src/sessionsCatalogState.ts) | Rows group and project recents derive from cwd. Introduce Chats using explicit binding; preserve Unknown workspace. |
| [`hostApi.ts`](../../app/shared/hostApi.ts), [`host.ts`](../../app/host/host.ts), [`registry.ts`](../../app/host/registry.ts) | Nonempty host-validated cwd, native-picker input tokens, two session identities, and restorable registry. Keep these boundaries. |
| [`openHistorySession.ts`](../../app/main/openHistorySession.ts), [`sessionsCatalogCache.ts`](../../app/sidecar/sessionsCatalogCache.ts), [`sessionStorage.ts`](../../src/utils/sessionStorage.ts) | Recover explicit binding through retained history, not just live registry rows. Do not widen the existing refusal of unknown cwd. |
| [`peerRequestPlane.ts`](../../app/main/peerRequestPlane.ts), `peersOf` | Existing peer membership compares cwd; managed membership needs the explicit R9 amendment above. |
| [`sessionController.ts`](../../app/sidecar/sessionController.ts), [`workspaceTrustDomain.ts`](../../app/sidecar/workspaceTrustDomain.ts), [`claudemd.ts`](../../src/utils/claudemd.ts) | Runtime initialization, project trust, and ancestor instruction discovery require a coherent managed context policy. |
| [`prompts.ts`](../../src/constants/prompts.ts), [`filesystem.ts`](../../src/utils/permissions/filesystem.ts), [`paths.ts`](../../src/memdir/paths.ts) | Existing scratchpad is gated and ephemeral; align scratch instructions and stable per-chat memory instead of relying on a folder name. |
| [`openWorkspaceFile.ts`](../../app/main/openWorkspaceFile.ts) | File open already checks canonical containment against host-owned session cwd. Reuse that boundary for generated file links. |

## Acceptance scenarios for later implementation

These describe product outcomes, not tests added in this design change.

1. With no project configured, type and submit a question. It runs without a
   folder picker; normal sign-in and model errors remain truthful.
2. Start a new chat while a real project is active. The new chat has No project;
   the project's **+** still starts a project chat.
3. Two independent chats each create and edit `report.md`. Their files differ,
   and both still exist after closing and reopening the app.
4. A no-project chat uses Bash, file tools, a configured global skill/MCP server,
   a subagent, and a peer under the existing permission modes. No blanket extra
   approval and no blanket bypass is introduced.
5. Place project instructions/configuration in the managed parent or a sibling
   chat. They do not become this chat's instructions, hooks, or tools on startup,
   compaction, or refresh. Global user instructions still load.
6. Resume after registry eviction through the session catalog. It remains a Chat
   with the original files, tool scope, and memory identity.
7. Explicitly remove a chat folder. History remains readable; continuing requires
   the visible recreate action and tells the agent that past files are absent.
8. Create a peer, hand off one absolute file path, and get a reply. Each session
   has its own default working directory; project peers remain out of scope.
9. Branch a conversation and verify the shared-files notice and conversation-only
   semantics. Closing either chat does not remove storage used by the other.
10. Retry failed creation, rapidly press Send, or cancel a folder picker. Preserve
    drafts/attachments and do not duplicate a submitted question.

## Review artifact and scope

[Interactive design mockup](../design-html/2026-09-26-no-project-chats.html)
covers New chat, a file-producing chat, parallel chats, and missing-file recovery.
It is a standalone local HTML artifact with sample conversations. Its state
controls and menus are interactive; native Finder/file-picker operations and
engine execution are not implemented. It borrows the real theme, local fonts,
sidebar density, and composer treatment. Account data and unrelated shell tools
are omitted to keep the proposed interaction inspectable.

V1 includes projectless creation, explicit binding, owned working directories,
normal agent capability, context discovery policy, files access, peer scope,
and durable restore. In-place project conversion, a file manager, shared scratch
root as every session's cwd, automatic cleanup, and new OS sandboxing are outside
this proposal.

Design-artifact validation: local document links and font/image paths resolve;
the inline script passes `node --check`; the four specimen states, project
selection with draft preservation, Files menu, Escape dismissal, search, and
missing-folder recreation were exercised in the browser. No browser warnings
or errors occurred after the mockup's search-selector fix. Workspace-map lint
passes with seven existing recommended-section warnings in untouched maps.
Application builds and runtime tests were not run because this change contains
only the specification and standalone mockup.
