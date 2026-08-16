# CC-59 renderer memory failure: the Blink-native mechanism

**Filed:** 2026-08-16
**Status:** Mechanism established. Investigation only — no application code was
changed. The last three attempts at this problem were plausible and wrong; this
report exists to show the evidence chain, including the two measurement traps
that produced wrong intermediate verdicts inside this same investigation.
**Scope:** Why a fresh desktop renderer streaming ~55 KB of text reached a
6.4 GB physical footprint and died in Chromium's deliberate PartitionAlloc
out-of-memory abort (`renderer.process.gone reason=crashed exitCode=5`), after
CC-59 transcript leaf virtualization had already landed and demonstrably bounded
the mounted DOM.

## Verdict

The memory is **React 19.2 development-build instrumentation, not transcript
rendering**. In dev builds, react-dom's "Component Performance Track"
(`logComponentRender` and friends in
`app/node_modules/react-dom/cjs/react-dom-client.development.js`) calls
`performance.measure('​<ComponentName>', { detail: { devtools: {
properties } } })` for every component render of every commit, where
`properties` is a serialization of the component's changed props **with no size
cap on string values**. Chromium stores each `detail` by **structured clone into
native PartitionAlloc memory** (User Timing L3), on a per-document timeline that
is **unbounded for marks and measures** and lives until navigation.

During a streamed turn the app commits ~45 times per second, and the streaming
message component's props embed the full accumulated markdown source, so the
per-commit clone grows with the transcript. The integral is quadratic. Nothing
ever reads or clears the buffer, no JS metric can see it (clone buffers are not
JS heap), and the renderer eventually takes Chromium's PartitionAlloc OOM abort
— the same abort class as both prior crashes.

Consequences of the mechanism:

- **Dev-only.** The production react-dom bundle contains none of this
  instrumentation, so packaged builds do not have this failure class. Dev is the
  operator's daily runtime, so it still matters operationally.
- **CC-59 virtualization is not refuted.** The mounted DOM really is bounded
  (reconfirmed under real layout in this investigation's harness, where the
  mounted node count stayed in the low hundreds while native memory ballooned).
  Virtualization fixed the previously dominant term; this is the other term,
  which no DOM-side change can touch and which dominates exactly on long
  streaming turns.
- The brief's `rehype-highlight` lead was a dead end, as its own text suspected:
  per-token re-tokenization is pure JS churn and leaks nothing natively
  (bisected below).

## 1. The measured failure, re-read

Run file: `app/.ram-scratch/trajectory/single-turn-2026-08-16T05-17-11-883Z.run.json`
(fresh app launch `32bfb0ab` at 05:17:00Z, renderer pid 87508, one session).

Three sources line up sample-for-sample: the trajectory run file, the
operational log's `renderer.health.sample` / `session.turn.*` records, and the
delivery traces (11,880 `stream_event` frames delivered, 11,457 applied, one
session `95cd896c`). The workload was **13 turns, not one prompt** (the brief's
"one prompt" is corrected by the log); total streamed text across all turns was
**~55 KB** (engine transcript `3f3fa745…`, 127 KB file including metadata).

What the correlation establishes:

1. **Growth happens only while commits happen.** Every memory burst sits inside
   a `session.turn.started/completed` window; between turns the footprint is
   flat to the megabyte (e.g. samples at 150–270 s: +2 commits, +0 MB).
2. **Nothing is ever reclaimed at idle.** Plateaus hold flat; after the last
   turn, `rendersCommitted` froze at 10,353 and tag-253 regions crept by zero
   (12:45 idle sample: 33,474 vs 33,509 earlier — slightly *down*).
3. **The per-commit cost escalates with accumulated transcript:**

   | Turn | Streamed chars | Commits in window | Native growth | Per commit |
   |---|---:|---:|---:|---:|
   | 1 | 18,345 | ~3,450 | ~630 MB | ~0.18 MB |
   | 3 | 9,951 | ~2,100 | ~270 MB | ~0.13 MB |
   | 4 | 7,101 | ~1,870 | ~970 MB | ~0.52 MB |
   | 8 | 14,758 | ~1,800 | ~4,600 MB | **~2.5 MB** |

   ~120,000 bytes of retained native memory per streamed byte, overall.

## 2. The allocation fingerprint (live renderer, full vmmap)

The failed-run renderer was still alive (6.6 G footprint, mostly swapped), so a
full per-region `vmmap 87508` was taken — read-only, per the incident playbook.
All growth is in `Memory Tag 253` (PartitionAlloc), committed rw- SM=PRV:

| Region class | Count | Dirty+swapped | Note |
|---|---:|---:|---|
| 4208K direct maps | 2,337 | 4,888 MB | each holds 2112–2160K, tightly clustered at ~2,144K |
| 64K spans | 10,417 | 592 MB | **≈ 1 per commit** (10,353 commits) |
| 192K spans | 2,237 | 407 MB | |
| 112K spans | 2,589 | 279 MB | |
| 160K spans | 1,633 | 232 MB | |
| 16K spans | 3,362 | 53 MB | |

Two properties of this table drove the rest of the investigation: the counts
scale with **commits**, not with content volume; and the big class is a
**fixed-size, repeated allocation** (a structure that *grew* would show one
large region, not 2,337 identical ones). The mid-size classes are the same
population as the direct maps at earlier transcript sizes: as the serialized
payload grows across turns it crosses PartitionAlloc size-class boundaries,
which is exactly the observed escalation in rate of the 4208K class.

Sum: 4,888 + 592 + 407 + 279 + 232 + 53 ≈ 6.45 GB ≈ the footprint. The V8/JS
side stayed flat throughout (JS heap peak 129.5 MB, V8 resident peak 264.8 MB).

## 3. Reproduction and bisection

Because launching the app is operator-gated and DevTools is a mutating probe on
a loaded renderer, the causal work ran in a disposable scratchpad harness in the
in-app Browser pane: a Vite page importing the **real**
`app/renderer/src/BoundedMarkdown.tsx`, `markdownRenderPlan.ts` and
`REHYPE_PLUGINS`, resolving react-dom from **the app's own `node_modules`**
(the identical `react-dom-client.development.js` 19.2.7 file the dev app
loads), driven at ~35–45 synthetic commits/second with a growing
prose-plus-fence document, measured externally with `vmmap` against the pane's
renderer process. Zero repository files were touched.

### 3.1 Two measurement traps, corrected mid-flight

Both produced wrong verdicts inside this investigation before being caught, and
both will bite any future memory work here:

- **PartitionAlloc region counts lie on a reused renderer.** After a page
  reload frees the old document, PA reuses the freed spans inside existing
  super pages, so a genuine leak can show *zero* region growth. Region count is
  only meaningful on a fresh process (the app never reloads, which is why its
  region count grew monotonically). The valid cross-run metric is tag-253
  **dirty+swapped bytes**, ideally on a fresh renderer per variant.
- **A reloaded page re-grows to a ~110 MB floor.** Module fetch, compile and
  steady-state allocation re-dirty ~60 MB after every reload; growth that stops
  at the floor mid-run is warm-up, not leak. Verdicts must compare **end states
  against the floor** and demand growth that continues past it.

(Also operational: the Browser pane is a hidden tab — rAF never fires, timers
throttle to 1 Hz, and a silent `AudioContext` does *not* lift throttling. The
harness drives ticks and a rAF shim through a wall-clock-gated `MessageChannel`
pump; the pump itself was exonerated by a spin-only control that stayed flat.)

### 3.2 The variant matrix

Fourteen runs; the decisive dimension is a page-level stub of
`performance.measure`/`performance.mark` installed before react-dom loads.
End-state tag-253 dirty+swapped, floor ≈ 105–116 MB:

| Variant | measure API | End state | Verdict |
|---|---|---:|---|
| Full pipeline (windowed + hljs + remap) | live | 181–197 MB | leaks |
| No ResizeObserver (all stubbed) | live | 195 MB | leaks — RO exonerated |
| No rehype-highlight | live | 191 MB | leaks — hljs exonerated |
| Stable components map | live | 190 MB | leaks — remap exonerated |
| Full mount, no windowing machinery | live | 197 MB | leaks — windowing exonerated |
| Plan only, nothing mounted | live | 186 MB | leaks — parse feeds props, still measured |
| Trivial commits (no parse, no layout read) | live | 130–141 MB | small leak — small props |
| **Full pipeline** | **stubbed** | **113 MB ≈ floor** | **no leak** |
| Trivial commits | stubbed | 113–117 MB ≈ floor | no leak |
| + console.timeStamp stubbed | stubbed | ≈ floor | timeStamp exonerated |
| Raw DOM writes, React removed | n/a (no React) | ≈ floor | DOM mutation exonerated |
| Spin-only control, zero commits | live | ≈ floor | pump/HUD exonerated |

Every variant with the measure API live ends above the floor, scaled by how
much prop content its components carry; every variant with it stubbed ends at
the floor, **including the complete real pipeline**. Prevention, not cure, is
the proof: `performance.clearMeasures()` on a leaked page freed only ~12 MB
immediately (freed clone buffers land in PA freelists and the pages stay
dirty), which is why the cure direction under-measures and the stub is the
correct experiment.

### 3.3 Direct observation of the buffer

On a trivial-commit run: `performance.getEntriesByType('measure').length` =
**1,728 for ~2,000 commits**, names `Update` (959), `​MessageBody` (760 —
React's zero-width-space track prefix), `Mount`, `Update Blocked`; the
`MessageBody` measures each carried a `detail` whose JSON serialization was
**~24 KB against a 12–36 KB source prop**. In the app, the analogous components
carry transcript-scale props, which is the ~2.1 MB clone class.

## 4. Source confirmation

`app/node_modules/react-dom/cjs/react-dom-client.development.js` (19.2.7;
`app/package.json` has pinned `^19.2.4` since the P1-0 walking skeleton):

- `logComponentRender` (line ~4096): for every named component rendered in a
  commit, when props changed since the alternate fiber, builds
  `addObjectDiffToProperties(alternate.memoizedProps, props, …)` and emits
  `performance.measure('​'+name, { …, detail: { devtools: { …,
  properties } } })` (detail assembly at ~25542,
  `reusableComponentDevToolDetails`).
- Error/effect paths (~4211, ~4260) serialize `fiber.memoizedProps` whole via
  `addObjectToProperties`.
- `addValueToProperties` stringifies values with **no length truncation** —
  string props are embedded in full; arrays of primitives are
  `JSON.stringify`'d whole; objects expand to one entry per nested field. The
  only `slice(…)` calls in the file are attribute-name prefixes.
- The dev bundle contains 17 `performance.measure` call sites and 46
  `console.timeStamp` call sites; the latter were separately stubbed and
  exonerated.
- The gate is `supportsUserTiming`, i.e. `performance.measure` being callable —
  there is no React-side buffer management, clearing, or size cap.

On the Chromium side, User Timing L3 `measure(name, { detail })` runs
structured-clone serialization at call time and retains the serialized buffer
with the `PerformanceMeasure` entry; the performance timeline has buffer limits
for resource timing but none for marks/measures; entries live for the document
lifetime. The clone buffers are native PartitionAlloc allocations — which is
why `jsHeapUsedBytes` (peak 129.5 MB), V8 residency, and any JS heap snapshot
are all blind to 6.3 GB of them.

## 5. Reconciliation with the prior record

- **2026-08-14 attribution ("95% Blink native, mounted DOM/layout/text") is
  not overturned for its own incident.** In that two-session read-heavy
  workload, closing both tabs dropped PA from 3.6 GB to 444 MB. Measure clones
  would *not* free on tab close (same document, same timeline); mounted DOM
  does. That occurrence was DOM-dominated; virtualization addressed it. The
  measure buffer was a second, smaller term there — and became the dominant and
  fatal term for the streaming workload once the DOM term was bounded.
- The 2026-08-09 SIGTRAP (selection-bounds shaping OOM) and the 2026-08-16
  DevTools kill (`Debugger.enable` re-parse OOM at 05:12:09) are both "a small
  allocation failed in a renderer already saturated by this mechanism", not
  independent leaks.
- The observability lesson repeats the incident report's: every in-app metric
  (`jsHeapUsedBytes`, working set pre-fix, `rendersCommitted`) either could not
  see this memory or could only correlate with it. `vmmap` tag histograms were
  the discriminating instrument, plus `rendersCommitted` as the event counter —
  exactly the pairing §7 of the final incidents report prescribes.

## 6. Not established

- **The app renderer was never probed directly** (DevTools ban on a loaded
  renderer stands; the 6.6 G renderer was left untouched). In-app attribution
  rests on: identical react-dom dev files loaded by both app and harness, the
  fingerprint arithmetic of §2, and the harness's causal stub proof. One
  operator observation would close it: on a fresh dev launch, attach DevTools
  *before* streaming (attach-at-launch is safe; the ban is attaching to a
  loaded renderer), stream one turn, and watch
  `performance.getEntriesByType('measure').length` track `rendersCommitted`
  while footprint grows.
- **Which app component mints the ~2.1 MB details** (plausibly the pane- or
  transcript-level component whose props carry the row array) is inferred from
  size, not observed by name.
- The tight ~2,144K clustering of the direct-map class is read as "serialized
  transcript-scale properties at this workload's size, rounded by the clone
  buffer's growth policy"; the exact buffer-capacity mechanics inside Blink
  were not traced.
- Harness Chromium is the Claude desktop app's, not Electron 33.4.11, and the
  harness page is hidden (no paint). Both caveats are mitigated by the
  fingerprint match against the app's own vmmap and by paint being absent from
  the causal chain.

## 7. Fix directions (deliberately unimplemented here)

The operator scoped this session to investigation only. Options, cheapest
first, all dev-runtime-only:

1. **Stub or wrap `performance.measure`/`mark` in the dev renderer entry**
   before React loads (drop `detail`, or drop measures with the `​`
   prefix). Proven equivalent to "no leak" in §3.2. Loses the DevTools
   Components performance track, which nobody here uses against this app.
2. **Periodic `performance.clearMeasures()/clearMarks()`** (e.g. per turn
   completion). Bounds the buffer instead of removing it; freed pages are
   reused rather than returned, so footprint stabilizes rather than shrinks.
3. **Serve production React in dev** via Vite define/alias. Removes the whole
   dev instrumentation family at the cost of dev warnings and component stacks.
4. **Upstream**: React's component performance track accumulates unbounded
   User Timing entries with uncapped prop serialization; any long-lived dev
   session streaming frequent commits with large props will OOM its renderer.
   Worth filing against react.dev with the numbers from this report.

Acceptance for any of them: `bun run --cwd app memory:trajectory` single-turn
workload — footprint must stop tracking `rendersCommitted`, and the
`curve-not-accelerating` and `region-growth-final-window` verdicts must pass
where they failed on 2026-08-16.

## 8. Evidence artifacts

Durable:

- `app/.ram-scratch/trajectory/single-turn-2026-08-16T05-17-11-883Z.run.json`
  (+ `.summary.txt`) — the measured failure.
- Operational log and delivery traces for launch `32bfb0ab` under
  `~/.cat-code/desktop/logs/`; preserved prior-occurrence traces (launch
  `ee7d59cd`, 101 MB) in the earlier session's scratchpad copy noted in the
  dispatch brief.
- Engine transcript `~/.cat-code/projects/-Users-pt-cat-code/3f3fa745-….jsonl`
  — the ~55 KB of streamed content.

Session-scratchpad (ephemeral, session `5d4a371d`): `vmmap-full-87508.txt`
(the §2 histogram source), `vmmap-harness-baseline.txt`, per-variant sample
logs, and the harness itself (`cc59-harness/` — `index.html`, `main.tsx`,
`vite.config.ts`), which imports repo modules read-only and can be recreated
from this report's description if needed.
