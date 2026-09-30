# Chat relocation feasibility checkpoint

> This is the pre-implementation probe. The implemented manual round trip and
> its verification are described in
> [CHAT-RELOCATION](../migration/decisions/CHAT-RELOCATION.md).

## Reproduce

From the repository root:

```sh
bun test app/host/chatRelocation.feasibility.probe.test.ts
bun run --cwd app typecheck:sidecar
git diff --check
```

The test needs permission to bind a temporary Unix socket. It creates and removes its own config home, managed Chat folder, desktop registry, and project folder. It does not launch Electron, use a live account, call a model, or enable relocation. The fixture writes a two-message conversation with `recordTranscript` after the real managed engine parks. Both saved outputs use `persistToolResult`. The probe changes files only under its disposable config home.

## Observed

- The managed engine parked safely. The fixture wrote two messages and a saved output. The host and sidecar resumed under the project cwd with the same app and engine IDs and replayed those messages. After a manual reverse move, the host and sidecar resumed under the original managed binding with the same IDs and replayed them again.
- The engine-session transcript lease excludes a competing resume while held. With only the JSONL moved, releasing the lease lets an ordinary project resume consume the partial move. This happens before the companion directory is relocated. If that resumed process writes output at the new location, a later directory rename meets an existing nonempty destination (`ENOTEMPTY` in the trial). The probe places its project-created output after the companion move for its successful link check; it does not reconcile that collision.
- Moving the companion directory makes the saved output's old absolute path disappear. A directory symlink at the old location restores filesystem access to that output and preserves one physical companion directory. The probe validates the link target before unlinking it for Move back, then creates a reverse link. Both pre-attachment and project-created output bytes remain reachable after return.
- The real `FileReadTool` permission path gives `allow` for the output in the current project companion directory, but `ask` for the old Chat path through the symlink. After Move back, the project-created output path likewise gets `ask` from the ordinary engine read policy rooted in the Chat cwd. A `Read` deny rule on the canonical target path gives `deny` through the symlink. Filesystem reachability therefore does not prove that saved references are readable without a new permission decision. The test does not grant wider access.

## Checkpoint decision

The two reported failures are not fixed by a contained two-rename or link change. No production relocation, move record, recovery path, resume guard, permission carve-out, or cleanup change was added. The probe records the failures and candidate behavior; it is not a safe feature implementation.

Durable recovery crosses several production owners:

| Owner | Required change before this can be enabled |
| --- | --- |
| `src/utils/transcriptLease.ts`, `src/utils/conversationRecovery.ts` | Persist and check an engine-ID move record under the lease. The shared loader handles ID, latest, file-path, and cached `LogOption` sources. It copies state, consumes interruption records, restores skill state, and runs resume hooks. A guard must reject an unfinished move before those effects. Terminal `src/main.tsx`, `src/cli/print.ts`, and `src/screens/ResumeConversation.tsx` currently load before their later lease acquisition; a sidecar-only check leaves a race. An error must remain a refusal in all fallback paths rather than becoming an empty conversation. |
| `app/host/host.ts`, `app/host/registry.ts`, `app/sidecar/sessionResume.ts`, `src/utils/sessionStorage.ts` | Reconcile transcript and companion paths, collisions, association metadata, registry binding, and lease handoff before ordinary resume. A durable record cannot be cleared merely because both renames occurred; the current association must also survive registry eviction and history reopening. Recovery must not rerun hooks or replay uncertain input while inspecting state. |
| `src/utils/permissions/filesystem.ts`, `src/utils/fsOperations.ts` | Any link exception must authenticate the exact session-owned old and current directories and still apply explicit ask/deny rules to lexical and resolved paths. The existing policy intentionally checks both forms. A generic allow for old project history paths would widen access. |
| `src/utils/cleanup.ts` | Its session sweep processes regular JSONL files and directories and ignores symlink entries. It cannot identify an obsolete compatibility link or decide when referenced output may be deleted. Link lifetime needs ownership and reference tracking, including reverse moves; unlinking only a validated link during a manual move is insufficient cleanup policy. |

No crash-recovery implementation exists to run the requested interruption checks during directory or link setup. The demonstrated partial resume and permission refusal mean the required safe recovery and old-reference readability evidence is **not met**. Project trust, project instructions, skill restoration, peers, deferred jobs, worktrees, matching, UI, and live model behavior remain outside this experiment and unresolved.

## Verification on this checkpoint

- `bun test app/host/chatRelocation.feasibility.probe.test.ts`: passed, one isolated process probe and 38 assertions. A first sandboxed attempt could not bind its temporary socket; the successful run had socket permission.
- `bun run --cwd app typecheck:sidecar`: passed. It reports 5,576 existing upstream diagnostics outside its scoped boundary.
- `bun run --cwd app typecheck`: failed with 7,995 lines of broad engine/type diagnostics, beginning with missing `src/*` module declarations. A search of that output found no diagnostics naming the changed probe or fixtures. This is not a clean package gate for the probe.
- `bun run maps:lint`: passed, 17 maps and no warnings.
- `git diff --check`: passed. The probe and report are untracked, so each was also checked with `git diff --no-index --check /dev/null <path>`; none emitted whitespace errors. Nothing was staged or committed.
