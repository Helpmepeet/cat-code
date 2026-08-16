# Hot active transcript, cold immutable archive (report §11 step 8)

Date: 2026-08-16
Status: design, unimplemented
Governing report: `docs/reports/2026-08-09-claude-code-compaction-evolution.md`
§10.5, §11 step 8. The report calls this the largest always-on-specific
redesign and requires design before any physical pruning.

## 1. The problem, stated more precisely than the report does

Cat already has a logical hot/cold split. On persistence a compact boundary
becomes a new active root with `parentUuid: null` and `logicalParentUuid`
pointing at the previous chain parent (`src/utils/sessionStorage.ts:1653`),
which yields two views: active resume follows `parentUuid` from the newest
boundary, archival display crosses it via `logicalParentUuid`
(`sessionStorage.ts:2720-2765`, `:2917`, `:4818`). Compaction is an
active-context cut, not deletion.

What is missing is the **physical** split. Both views live in one file,
`<projectDir>/<sessionId>.jsonl` (`sessionStorage.ts:242-245`), and the loader
reads the file, not the active window. There is no size ceiling on that path:
`MAX_TRANSCRIPT_READ_BYTES` (50 MiB, `sessionStorage.ts:269`) is referenced by
exactly one caller, `src/components/Feedback.tsx:143`, for bug reports; the
chunked reader's own `MAX_CHUNK_BYTES` is 100 MiB (`sessionStorage.ts:1116`).

So resume cost scales with total session bytes rather than active-context bytes.
For an always-on agent that is the whole problem, and it is a sharper statement
than "add an archive": the archive is the means, bounded resume is the goal.

One correction from the report's own §15.2 matters here. The post-compact
summary **already** instructs the model to read the full transcript at
`transcriptPath` (`prompt.ts:837-839`). That escape hatch exists and degrades as
the file grows. This work replaces it; it does not add a missing capability.

## 2. Artifacts

Three files per session, replacing one.

| File | Role |
|---|---|
| `<sessionId>.jsonl` | **Hot.** The active generation only: the newest boundary and every record after it. Bounded by the context window. |
| `<sessionId>.archive.jsonl` | **Cold.** Append-only, immutable, every record ever written in original order. Never rewritten, never truncated. |
| `<sessionId>.ledger.jsonl` | One record per compaction generation. |

Ledger record:

```text
{
  generation,            boundaryUuid,      summaryUuid,
  parentGeneration,      preservedUuids[],
  archiveByteRange:      { start, end },
  archiveRecordRange:    { first, last },
  model, promptVersion,  preTokens, postTokens,
  checksum
}
```

**Why a separate ledger and not more boundary metadata.** The boundary lives in
the hot file, which is exactly the file this design truncates. The ledger has to
outlive every truncation and be readable without parsing either transcript.
Putting the covered-range table in the boundary would delete the index along
with the data it indexes.

The `generation` field is the same ordinal as the companion design
(`docs/plans/2026-08-16-compaction-generation-events-design.md` §3.1). These two documents
share it deliberately: it is what lets a remote client name the archive range it
is asking about.

## 3. Migration, which is the part that decides whether this is buildable

Physical pruning last, in three reversible phases. Each phase ships alone.

**Phase 1, write-only.** Start writing the archive and the ledger alongside the
existing single file. Nothing reads them. The hot file is unchanged, so there is
no behavior change and no rollback risk. This phase exists to prove the write
path against real always-on sessions, which is the only way to find out what the
record stream actually contains.

**Phase 2, read the archive for the archival view.** Point the
`logicalParentUuid` walk at the archive instead of at the hot file, while the
hot file still holds everything. Both sources must now produce the same archival
history, and that equivalence is the checkable invariant of this phase: it can
be tested against real transcripts, offline, at scale, before anything is
deleted. A mismatch is a bug in the archive writer, discovered while the
original data is still present.

**Phase 3, truncate.** Only now does the hot file get cut at the boundary. By
this point the archive has been proven to reproduce the archival view.

A session with no archive file falls back to today's behavior, so existing
transcripts need no migration: they are already valid hot files that happen to
contain their own history.

## 4. Retrieval instead of "read the JSONL"

Replace the `prompt.ts:837-839` instruction with a bounded lookup over the
archive, keyed by the ledger: given a generation, a uuid, or a text query,
return a bounded range of records. The model never receives a path to a
multi-gigabyte file, which is §10.5's explicit requirement.

The ledger's `archiveByteRange` is what makes this cheap: resolving "what was in
generation 4" is a seek and a bounded read, not a scan.

## 5. What must not break

`applyPreservedSegmentRelinks` (`sessionStorage.ts:2527-2644`) validates the
tail-to-head walk and, on validation failure, fails safe by retaining full
history rather than building a broken chain (report §4.9). After Phase 3 there
is no full history in the hot file to retain, so that fail-safe must be
re-pointed at the archive. This is an improvement rather than a hazard: today
the fail-safe can only decline to relink, whereas with an archive it has
somewhere to recover from. It is also the single place where getting the
sequencing wrong loses data, so it should be re-pointed in Phase 2, before
truncation, not during Phase 3.

## 6. Cost

Bytes written per session roughly double during Phases 1 and 2, since every
record lands in both files. From Phase 3 the hot file shrinks to the active
window, so steady-state disk is approximately today's total plus a small ledger.
The peak is transitional, not permanent, and it buys the ability to verify the
archive against the original before trusting it.

## 7. Open questions

- **Snip versus archive, unresolved.** `HISTORY_SNIP` removes records from the
  active view (`services/compact/snipProjection.ts`, `snipCompact.ts`). An
  immutable archive by definition keeps them. If a user snips for privacy rather
  than for context economy, "immutable" is the wrong answer and the archive
  becomes a way to recover what they asked to remove. This needs an explicit
  decision about what snip means before Phase 1 writes anything, because Phase 1
  is what starts creating the durable copy.
- Checksum granularity: per record, per generation range, or per file. Per
  generation range is the cheapest thing that still localizes corruption, but
  this was not traced against the existing tombstone-rewrite path
  (`sessionStorage.ts:154`, `:1466-1532`), which rewrites the file in place and
  would invalidate any whole-file checksum.
- Whether subagent sidechain transcripts get their own archives, or fold into
  the parent's. Same open question as the companion design's §5.
- Interaction with the desktop's own transcript backfill
  (`app/shared/transcriptBackfill.ts:344`, `app/shared/transcriptRunFacts.ts:281-350`),
  which locates the newest boundary and its preserved segment by reading the
  transcript directly. Phase 3 changes what that read finds. Not traced.
