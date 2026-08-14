# Renderer memory attributed: 95% is Blink PartitionAlloc, not JavaScript

Measurement session of 2026-08-14 evening, following
`docs/reports/2026-08-14-renderer-freeze-and-devtools-crash.md`. That report left
the 6.7 GB unattributed. This one attributes it, reproduces the growth on demand,
and corrects four claims made earlier the same day, including two of my own.

Method: `footprint -p <pid>` and `vmmap --summary <pid>` against a **live**
renderer. No code changes, no DevTools (opening it is fatal on a loaded
renderer). The `footprint` per-category table is what produced the attribution;
`vmmap --summary` alone cannot, because it cannot introspect Chromium's
PartitionAlloc zone and says so.

## The attribution

At 3.9 GB, with both sessions live:

```
Dirty      Regions   Category
3653 MB    13953     app-specific tag 14   = PartitionAlloc (Blink native)
 182 MB    10671     app-specific tag 16   = V8 (JavaScript heap)
```

**95% of the renderer is native browser-engine memory.** The entire JavaScript
heap is 182 MB.

This is the finding the whole investigation was missing. It means the memory is
DOM nodes, layout objects, text fragments and related Blink structures, not the
application's own data structures. Any fix aimed at JavaScript state has a
ceiling of roughly 182 MB, which is a rounding error against 3.65 GB.

## Reproduction on demand

Previously this pathology had only been seen after the fact. It now reproduces
in minutes. Workload: two sessions, each told to read every file over 400 lines
in a directory and write a detailed summary of each — heavy tool output plus
sustained streamed prose into a growing transcript.

| Point | Footprint | PA resident | PA dirty | Regions |
|---|---:|---:|---:|---:|
| Fresh launch | 144 MB | 68.0 MB | 52.1 MB | 852 |
| Both sessions working (~15 min) | 1,412 MB | 1.1 G | 1.1 G | 5,366 |
| Shortly after | 3,974 MB | 3.6 G | 3.6 G | 13,018 |
| Both tabs closed | 3,918 MB | 3.7 G | 3.6 G | 14,319 |

Roughly 10× in fifteen minutes, and **accelerating** — the second interval added
more than the first despite being shorter. That shape is consistent with cost per
frame rising as the transcript grows, and with the dead renderer reaching 6.7 GB
in 46 minutes.

Note also that dirty converged on resident (1.1 G / 1.1 G, then 3.6 G / 3.6 G).
This memory is written and committed, not reclaimable pages.

## Closing both tabs freed 1.4%, and did NOT test the leak fix

3,974 MB → 3,918 MB, with region count *rising* 13,018 → 14,319.

The obvious reading is a retention leak. **That reading is wrong, and I published
it before checking.** `Host.closeSession` (`app/host/host.ts:506`) kills the
sidecar and evicts replay, but the registry row is deliberately KEPT for a
restorable session (`app/host/host.ts:522`), and the comment at `:527` states
that what it emits turns on restorability: `session-removed` fires **only** when
a session is not restorable — no engine session id, or a transcript that no
longer exists. Both test sessions had engine transcripts, so closing them parked
them as restore offers.

Two consequences:

1. **The `session-removed` path was never exercised**, so this measurement says
   nothing about whether the leak fix in `287cb9bb` works.
2. **That fix sits on an uncommon path.** It is a real defect fix, correctly
   built, but ordinary session closing does not trigger it. Its practical impact
   is smaller than its description suggests.

## The strongest remaining lead

A closed-but-restorable session keeps its **entire projected transcript and raw
message log resident in the renderer**, indefinitely, purely to serve a restore
offer — while the durable source for a restore is the engine transcript on disk.

If parking released the renderer-side projection and re-derived it on restore,
the retained footprint would drop without touching the rendering path at all.
This is untested and is now the first thing to test, because it is cheaper than
virtualization and would explain the flat 3.9 GB after both tabs closed.

What was NOT determined, and should not be assumed: whether the transcript pane's
DOM actually unmounts when a session parks. If it unmounts and PartitionAlloc
still does not fall, the memory is retained below the application layer and
neither store eviction nor virtualization is the answer. That check was in
progress when this session ended.

## Corrections to earlier records

- **The "32 GB of PartitionAlloc address space" in
  `docs/reports/2026-08-09-renderer-sigtrap-root-cause.md` is not evidence of a
  pathology.** A healthy renderer at 159 MB footprint shows the same 32.0 G. It
  is PartitionAlloc's fixed virtual reservation. The meaningful variables are
  dirty bytes and region count. That report's region-count observation stands;
  its address-space argument does not.
- **Transcript virtualization**, withdrawn on 2026-08-14 morning because the
  crash stack pointed at V8 parsing rather than rendering, is supported again by
  the compartment split — but it is NOT established, because the parked-session
  retention above is an untested alternative that would explain the same numbers.
  The plan's "deliberately not doing" entry is superseded by this file.
- **`vmmap --summary` column labels**: in earlier notes I reported the resident
  column as dirty. Resident is column 5, dirty is column 6. The conclusions were
  unaffected, the figures were mislabeled.
- **My detached-DOM retention claim**, made from the closed-tabs reading before
  checking `closeSession`, is retracted per the section above.

## Unrelated defect found and fixed in the same session

The desktop security gate had been failing at HEAD since 2026-08-13. The preload
method `openWorkspaceFile` landed in `34b2aee8` without being added to the
hardening allowlist, and seven subsequent `app/` commits landed with the gate
red. `queryStats`, from the in-flight usage-analytics work, was missing for the
same reason.

Both are validated — `openWorkspaceFile` re-validates the whole payload in main
with a realpath containment check that defeats traversal and symlink escape, and
`stats.query` is schema-validated at the sidecar and fails closed. Only the
bookkeeping was skipped. Entries added in `40149284`; the gate is 19/19.

A permanently-red gate is a disabled gate: the next unauthorized bridge method
would have produced exactly the output nobody was reading.

## Reproduction recipe, for the next session

```bash
pid=$(pgrep -f "Cat Code Dev.*type=renderer" | head -1)
footprint -p $pid | head -12          # per-category: tag 14 = PartitionAlloc, tag 16 = V8
vmmap --summary $pid | grep -E "^Memory Tag 253 +[0-9]"
```

Watch **region count** above all: it climbs monotonically and does not fall when
footprint does. Fresh launch is around 850; the 2026-08-14 morning crash was at
22,959.

Do not open DevTools to investigate this. It is a mutating probe and it killed a
renderer earlier the same day.
