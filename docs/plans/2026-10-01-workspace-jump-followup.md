# Workspace jump GUI follow-up and initial workspace catalog

Status: implemented; isolated verification complete. Post-fix GUI and live-model
latency/judgment verification remain unperformed.

The user supplied the October 1 GUI verification report and authorized GPT-6.1
Sol agents at high effort to handle its problems. They also proposed supplying
recent workspace metadata initially to avoid a model discovery round trip.
This follows [the initial workspace-jump plan](2026-09-30-agent-workspace-jump.md)
and retains its conversational-agent authority, one-success limit, and trust,
identity, persistence, permission, transport, and recovery contracts.

## GUI evidence and required corrections

- Five unstopped Sol jumps answered their requests, then recorded cancelled
  outcomes and displayed a stopped notice. A replacement restores a reservation
  before socket attachment but has no source handoff result. The source-failure
  fallback wrongly treated that expected destination state as a reason to
  cancel. Limit that inference to a locally reserved source operation; preserve
  explicit Stop and host-owned recovery of restored operations.
- Luna answered the exact simple-project question without calling either
  workspace tool; Sol jumped for the same text. Source already contains that
  example, and provider logs distinguish main requests from title generation.
  Historical exact prompt delivery and the reason for Luna's decision remain
  unproven. Concrete initial metadata and clearer action guidance address the
  available information; they cannot guarantee model judgment.
- The debug producer exported 241 sidebar rows while the receiver caps diagnostic
  collections at 128. Preserve that receiving bound and sample newest rows while
  retaining the active row. Full host session rows remain available for locating
  conversations. No diagnostic data enters model prompts.
- Backfill loaded relocated conversations using the batch worker's process cwd,
  rather than their authoritative completed-relocation target. Use the existing
  scoped cwd owner for observation-only preview loading, retain all identity/path
  gates and unreadable/incomplete-record refusals, and do not consume interrupted
  recovery state during preview. A historical record lacking required controls
  remains quarantined; this task does not repair saved state.

## Faster initial context

Inject at most eight recent distinct canonical trusted workspaces, bounded to
8 KiB of serialized metadata. A row contains only its name, canonical absolute
path, and an opaque host-issued jump handle. The catalog is data; presence grants
no permission and loads no candidate files, instructions, hooks, memory, or
executable workspace configuration. Do not inject conversation titles, IDs,
transcript text, settings, credentials, or diagnostics.

Recency comes from existing message, attachment, and catalog-modification
timestamps. Collapse duplicate conversations and canonical aliases, retaining
the greatest recency for each workspace; order newest first with a deterministic
path tie break. Apply the existing 128 unique-root discovery bound after
deduplication, then the smaller initial-context count and byte bounds.

Reuse the existing authenticated `workspaces.list` request as an automatic
metadata observation before the first conversational provider call. It does not
read or classify the user's text, select a destination, or generate a model tool
exchange. A narrow optional runtime system-prompt callback passes the result
through the real QueryEngine after input processing/persistence and before model
work. Callers without the callback keep their current behavior.

Concurrent provisioning shares one promise. Freeze the initial successful
snapshot within the process; an unavailable observation falls back to ordinary
listing guidance without fabricated entries or unbounded retries. Stop during
provisioning must prevent provider admission while preserving accepted input.
Late or stale results must not revive cancelled work or overwrite another
process's metadata. Project-created and consumed contexts do not provision a
fresh jump catalog.

Keep metadata outside tool descriptions so tool schema bytes remain the same
across eligible, consumed, and project-bound contexts. Fixed guidance permits
direct `JumpWorkspace` with an initial handle. Use `ListWorkspaces` when the
relevant workspace is absent or more discovery is needed. A clear mentioned
project remains sufficient; competing ambiguous targets ask, reference projects
do not automatically become targets, and explicit instructions not to move win.
“Reply in chat only,” “plan only,” and “do not edit files” constrain output/work
rather than forbidding movement by themselves.

Handles remain ephemeral and bound to the conversation and source process
generation. A later explicit listing must not invalidate an initial handle for
the same still-known canonical workspace. Retained mappings remain bounded;
expired generations and roots lose authority. Acceptance and readiness still
revalidate current known roots, canonical identity, saved trust, eligibility,
cancellation, and ordinary permission policy. Restart issues fresh metadata and
does not reset consumption.

The existing policy can base-allow a comparable desktop host action. The
canonical destination projection is available if policy routes the action
through Auto; this change does not require an extra classifier request for
every jump.

For an initially listed destination, the model path becomes:

```text
initial workspace metadata → conversational-agent judgment → JumpWorkspace
```

This removes the model response between discovery and jumping. Local metadata
IPC/trust observation and extra prompt tokens still cost time. The prior GUI
samples measured approximately 6.8–11 seconds from sending to destination
observation and 1.7–2.0 seconds from acceptance to that observation. They include
an erroneous cancellation outcome and do not establish the new path's speedup.

## Ownership and validation

The orchestrator delegates cancellation, judgment/catalog, debug export, and
backfill to separate GPT-6.1 Sol high-effort tasks with non-overlapping owners.
Agents preserve other sessions' dirty files and do not commit independently.
The orchestrator owns contract/map updates, integration checks, and scoped commit.

Use real owner regressions that demonstrate failure before repair and pass
afterward. Exercise restored destination attachment before continuation, explicit
Stop and source-failure settlement; real debug producer-to-receiver overflow;
actual moved-transcript preview with unchanged durable state; and initial
metadata through the real provider/query boundary with direct seeded-handle
selection, ordinary permission projection, stable schemas, recency/dedup bounds,
fallback, abort, and stale authority refusals.

Run focused checks and broader affected package/build/typecheck/doc checks after
integration. Earlier full-app runs have five renderer failures also reproduced
at HEAD; do not repair another session's slice. Engine diagnostics have an
existing baseline; require no new owned errors.

This task authorizes isolated scripted-provider/module/worker/sidecar tests,
not another GUI/Electron launch, real-model/account call, installation, or live
saved-state repair. Existing GUI artifacts may be read for diagnosis. A later
authorized GUI run should repeat successful Sol/Luna jumps without pressing
Stop, verify clean settled outcomes and renderer debug freshness, and compare
send-to-destination samples using the same prompts/model/settings.

## Completed verification

The four delegated slices landed together without changing the locked transport,
process, identity, raw-event, or relocation-record formats. Contract amendments
are recorded in [host requests](../migration/decisions/HOST-REQUEST-PLANE.md) and
[Chat relocation](../migration/decisions/CHAT-RELOCATION.md). No app was launched,
no live model/account request was made, and no saved user state was repaired.

| Owner | Evidence |
|---|---|
| Destination cancellation | Two restored-attachment regressions emitted `workspace.cancel` before the fix. The corrected real sidecar/controller boundary passes nine cases, including source failure and explicit Stop before/during/after continuation; two existing replacement-startup process tests also pass. |
| Initial catalog | The first-query test fails against the prior QueryEngine because initial metadata is absent. Four isolated scripted-provider checks pass for delivered metadata/direct jump, callback throw/rejection fallback, and Stop/late-result/input recovery. The real classifier projection receives the canonical path when classification is used. |
| Debug export | The real producer/receiver regression rejected a 129-row roster before repair. Current 128/129/241/256-row cases retain the active row within the diagnostic cap and pass receiver validation. The receiver still rejects oversized or malformed incoming collections. |
| Preview backfill | A real engine-created and relocated transcript failed its preview cwd check before repair. Corrected process coverage loads the authoritative target while preserving transcript, relocation, and interruption-recovery bytes; mismatched, moving, and unreadable records remain refused. |

Final integration results:

- `bun test ./app/`: 5,234 passed, three existing skips, five previously confirmed
  baseline renderer failures, zero runtime errors; 5,242 tests across 360 files.
  The failures are the App CC-16 drain, foreground-subagent, and D5 refused-submit
  source tripwires, memory waiting-state literal, and unread-settings literal
  already documented in the initial plan. No additional failure remains.
- Focused coordinator/tool/config/debug owners: 76 passed. Five engine handoff,
  MCP, deferred, setup, and controller files run in separate Bun invocations:
  20 passed. These overlap with earlier agent checks and are not a unique total.
- The new catalog test uses a fresh Bun child because existing suites install
  persistent classifier module mocks. Its four child checks pass; the parent
  check also passes alongside the previously interfering worker-outcome suite.
  No production-only testing seam or new permission behavior was added.
- `bun run build:dev:full`, desktop typecheck, scoped sidecar typecheck, and
  renderer build passed. Root TypeScript still has its inherited errors:
  1,066 unique diagnostics before and after normalizing source line/column
  movement, with zero added or removed diagnostics. The scoped sidecar wrapper
  ignores 5,573 existing upstream diagnostics.
- Map lint, local documentation links, and `git diff --check` passed. The four
  pre-existing tracked dirty files retain their exact initial hashes. Other
  sessions' untracked files are excluded from this commit.

Initial combined checks exposed persistent module-mock interference in the new
classifier test. The isolated runner fixed it before the final whole-app rerun.
An exploratory combined engine invocation likewise conflicted with the deferred
suite's persistent query mock; the required real-owner checks pass in separate
processes. Sandbox-denied Unix-socket checks and the user-interrupted rerun are
not counted as successful verification.

Detailed owner reports and command logs are under
`/tmp/catcode-workspace-followup/`. The valid moved-preview fix does not establish
that every historical warning disappears. One saved relocation record lacks
required controls and remains untouched and refused. The metadata test establishes
actual first-request delivery with a scripted provider; it does not establish
Luna's future natural-language decisions or a measured speedup.

## Remaining GUI checks

These are operator steps, not checks performed by this follow-up:

1. Fully restart Cat Code Dev to reload main and sidecar changes. Use a known
   trusted workspace used recently, then create a fresh normal Chat with Sol
   low effort and Auto. Send `What is cat-code? Reply in chat only; do not edit
   files.` Expect a jump followed by an answer. The transcript should show
   `JumpWorkspace` without `ListWorkspaces` for a supplied recent destination.
   There should be one original input and no stopped notice. Repeat in another
   fresh Chat with Luna using the same settings and prompt.
2. Check the operation after the destination answer: `phase: settled`,
   `outcome: completed`, `cancelled: false`, continuation `state: settled`, and
   `requiresUserReconciliation: false`. The source and destination keep the
   same app and engine conversation identities. An answer alone is insufficient
   evidence; that was true even for the faulty October 1 samples.
3. For a trusted known workspace absent from the initial recent sample, expect
   the agent to use `ListWorkspaces` before choosing a handle. For two ambiguous
   mentioned workspaces, expect clarification. For `Explain cat-code, but do
   not change workspace`, expect the answer in Chat. After one successful jump,
   ask about another project and expect ordinary tools without a second jump.
4. In fresh Chats, exercise immediate Stop and Stop during destination work.
   No cancelled catalog request may start a model call later. A Stop after
   relocation suppresses continuation/replay, retains durable location, and
   leaves the existing explicit reconciliation flow available.
5. With more than 128 saved host rows, verify a fresh non-null renderer debug
   snapshot, a sidebar sample of at most 128 including the active row, and the
   complete separate host roster. Restart with valid moved histories and
   confirm their previews load. A genuinely malformed historical relocation
   record must remain refused and unchanged, rather than being silently repaired.
6. Compare several fresh-Chat send-to-destination samples against the old
   prompts, model, effort, permission mode, and warm/cold conditions. Also record
   acceptance-to-destination separately. Confirm clean settlement before using
   a sample as successful timing evidence. No new latency number is claimed
   from the isolated scripted tests.
