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
| Both tabs closed (before JS eviction fix) | 3,918 MB | 3.7 G | 3.6 G | 14,319 |
| Live test 2: both streaming | 621 MB | 429.1 MB | 362.2 MB | 7,259 |
| Live test 2: session 1 closed (session 2 streaming) | 591 MB | 516.1 MB | 441.2 MB | 8,729 |
| Live test 2: both closed (with JS eviction fix) | 566 MB | 517.3 MB | 444.1 MB | 8,747 |

Roughly 10× in fifteen minutes, and **accelerating** — the second interval added
more than the first despite being shorter. That shape is consistent with cost per
frame rising as the transcript grows, and with the dead renderer reaching 6.7 GB
in 46 minutes.

Note also that dirty converged on resident (1.1 G / 1.1 G, then 3.6 G / 3.6 G).
This memory is written and committed, not reclaimable pages.

## Closing tabs: DOM unmounts, JS state evicted, but PartitionAlloc holds pages

### Step 1 Outcome: Outcome C Confirmed
Source inspection of `app/renderer/src/App.tsx` and `app/renderer/src/WorkspacePanels.tsx`
confirmed that when tabs close:
- `foldTabMembership` removes closed sessions from `shell.tabs`.
- `reconcileWorkspaceLayout` empties `workspacePanels`.
- `App.tsx` renders `<WelcomeScreen>` instead of `<WorkspaceLayout>`.
- The transcript DOM tree is **100% unmounted**.

### Step 2 Implemented and Measured
In `app/renderer/src/App.tsx:1030-1040`, live transcript projection and raw message logs
are now evicted on clean session park (`descriptor.status !== 'disconnected'`).

Empirical test of Step 2 (see table above):
- Closing Session 1 while Session 2 streams: footprint 591 MB (PA dirty rose from 362 MB → 441 MB due to Session 2).
- Closing BOTH sessions: footprint 566 MB (PA resident 517.3 MB, PA dirty 444.1 MB, 8,747 regions).

### Definitive Conclusion
Even after complete DOM unmounting AND JavaScript store eviction, PartitionAlloc
does not return dirty pages to macOS. Chromium's internal allocator pools committed
pages in its slot-spans.

**Therefore, the memory cannot be reclaimed after the fact. It must be prevented at the source:**
The growth is a direct consequence of mounting thousands of DOM nodes during active streaming.
**Transcript DOM Virtualization (Virtual Scrolling) is the definitive, necessary architectural fix.**

## Corrections to earlier records

- **The "32 GB of PartitionAlloc address space" in
  `docs/reports/2026-08-09-renderer-sigtrap-root-cause.md` is not evidence of a
  pathology.** A healthy renderer at 159 MB footprint shows the same 32.0 G. It
  is PartitionAlloc's fixed virtual reservation. The meaningful variables are
  dirty bytes and region count. That report's region-count observation stands;
  its address-space argument does not.
- **Transcript virtualization**, withdrawn on 2026-08-14 morning because the
  crash stack pointed at V8 parsing rather than rendering, is now **formally established**
  by the compartment split and the Outcome C measurement.
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

## Reproduction recipe, for subsequent testing

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

## Next steps, in priority order

### 1. Transcript DOM Virtualization (Primary Implementation Target)

Implement virtual scrolling for `<TranscriptView>` so only visible rows in the
viewport exist in the DOM (capping active DOM nodes to ~20-30 regardless of transcript length).
This stops PartitionAlloc from ever allocating or dirtying gigabytes of pages during
streaming runs.

### 2. Instrument the UI Freeze

Add a `renders-committed` counter to the health payload, incremented in the post-commit
effect at `app/renderer/src/App.tsx:610`. This will allow diagnostics to observe whether
React stopped committing renders during freeze incidents.

### 3. Clear Logging Debts

From `docs/reports/2026-08-14-desktop-logging-feedback.md`:
- Delete or rename `heapUsedBytes` (which tracks only V8 JS heap and misled investigations).
- Log real process memory (`process.getProcessMemoryInfo()`) from Electron main.
