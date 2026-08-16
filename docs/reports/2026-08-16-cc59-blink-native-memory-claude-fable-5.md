# CC-59 renderer memory failure: the Blink-native mechanism

**Filed:** 2026-08-16
**Status:** Mechanism established. Investigation only — no application code was
changed. The last three attempts at this problem were plausible and wrong, so
this report records the complete evidence chain, every candidate that was
eliminated with the observation that eliminated it, and the two measurement
traps that produced wrong intermediate verdicts *inside this same
investigation* before being caught.
**Scope:** Why a fresh desktop renderer streaming ~55 KB of text reached a
6.4 GB physical footprint and died in Chromium's deliberate PartitionAlloc
out-of-memory abort (`renderer.process.gone reason=crashed exitCode=5`), after
CC-59 transcript leaf virtualization had already landed and demonstrably
bounded the mounted DOM.

---

## 0. Verdict

The memory is **React 19.2 development-build instrumentation, not transcript
rendering**. The chain has three layers:

1. **App layer.** The dev app (`bun run --cwd app dev`) serves the renderer
   from Vite in development mode, which loads
   `react-dom/cjs/react-dom-client.development.js` (19.2.7 in
   `app/node_modules`; `^19.2.4` pinned since the P1-0 walking skeleton).
2. **React layer.** The dev build's "Component Performance Track"
   (`logComponentRender` and siblings) calls
   `performance.measure('​<ComponentName>', { detail: { devtools: {
   properties } } })` for **every named component render of every commit**,
   where `properties` serializes the component's changed props **with no size
   cap on string values**. During streaming, the message component's props
   embed the full accumulated markdown source, and pane/transcript-level
   components carry row arrays, so the payload grows with the transcript.
3. **Chromium layer.** `performance.measure` with a `detail` runs **structured
   clone at call time** and stores the serialized buffer natively, attached to
   the `PerformanceMeasure` entry. The User Timing timeline is per-document,
   **unbounded for marks and measures** (only resource timing has a buffer
   cap), and lives until navigation. On macOS the clone buffers land in
   PartitionAlloc (vmmap `Memory Tag 253`) — invisible to `usedJSHeapSize`,
   V8 residency, and JS heap snapshots alike.

At ~45 commits/second, per-commit clone size growing with the transcript, the
integral is quadratic. Nothing reads or clears the buffer. The renderer dies in
the same PartitionAlloc abort class as both prior crashes.

Consequences:

- **Dev-only.** Production react-dom contains none of this instrumentation, so
  packaged builds do not have this failure class. Dev is the operator's daily
  runtime, so it still matters operationally.
- **CC-59 virtualization is not refuted.** The mounted DOM really is bounded
  (reconfirmed under real layout in the harness: mounted node count stayed in
  the low hundreds while native memory ballooned). Virtualization fixed the
  previously dominant term; this is the *other* term, untouchable by any
  DOM-side change, dominant exactly on long streaming turns.
- The brief's `rehype-highlight` lead was a dead end, as its own text
  suspected: per-token re-tokenization is pure JS churn and leaks nothing
  natively (§7, variants V3/V6).

---

## 1. The failure record

### 1.1 Timeline of 2026-08-16

| Time (Z) | Event |
|---|---|
| 04:53:55 | App launch `ee7d59cd` (the "prior occurrence"). Streaming session `6fea47de` balloons the renderer. |
| 05:12:09 | DevTools attached to that loaded renderer → `Debugger.enable` re-parse → allocation failure → `exitCode=5`. Renderer replaced. Traces preserved (101 MB). |
| 05:17:00 | Fresh app launch `32bfb0ab` (main pid 87489, renderer pid 87508) — **the measured run**. |
| 05:17:11 | `bun run --cwd app memory:trajectory` starts sampling every 30 s (24 samples). |
| 05:17:49–05:29:45 | Thirteen turns stream in one session (`appSessionId 95cd896c`, engine transcript `3f3fa745`). |
| 05:28:42 | Trajectory run ends: footprint 6,451 MB, verdict 3 FAIL. |
| 05:30:35 | `rendersCommitted` freezes at 10,353; renderer sits idle, 6.4 G committed (mostly swapped), **not growing**. |
| ~12:59 local | This investigation takes a full per-region vmmap of the still-alive renderer. |

Correction to the brief: the operational log shows the workload was **13
turns**, not one prompt, and the measured launch was `32bfb0ab` at 05:17:00Z
(the 11:53:55 launch was the prior occurrence). Neither correction weakens the
run's cleanliness — it was a fresh launch, one session, post-CC-59 renderer.

### 1.2 The trajectory samples (run file, all 24)

`app/.ram-scratch/trajectory/single-turn-2026-08-16T05-17-11-883Z.run.json`.
MB = MiB. `commits` = `rendersCommitted` from the app's own
`renderer.health.sample` (30 s cadence, `healthAgeMs` ~6.5 s at each pairing).

| # | t | Footprint | PA dirty | PA swapped | PA regions | V8 res | JS heap | commits |
|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| 0 | 0.0m | 154.0 | 55.0 | 0 | 897 | 87.5 | — | — |
| 1 | 0.5m | 104.3 | 62.6 | 0 | 996 | 34.2 | 38.0 | 34 |
| 2 | 1.0m | 166.0 | 96.6 | 0 | 2,262 | 61.8 | 46.8 | 325 |
| 3 | 1.5m | 384.4 | 296.1 | 0 | 5,001 | 78.1 | 41.6 | 1,865 |
| 4 | 2.0m | 765.2 | 659.8 | 0 | 10,049 | 92.6 | 40.6 | 3,449 |
| 5 | 2.5m | 743.6 | 677.5 | 0 | 10,302 | 68.4 | 42.0 | 3,903 |
| 6 | 3.0m | 744.6 | 677.6 | 0 | 10,306 | 69.4 | 42.2 | 3,905 |
| 7 | 3.5m | 744.5 | 677.4 | 0 | 10,307 | 69.6 | 42.5 | 3,906 |
| 8 | 4.0m | 745.0 | 677.5 | 0 | 10,309 | 69.9 | 42.7 | 3,908 |
| 9 | 4.5m | 766.9 | 681.9 | 0 | 10,365 | 87.4 | 43.6 | 3,956 |
| 10 | 5.0m | 942.3 | 837.0 | 0 | 12,670 | 103.6 | 44.6 | 5,208 |
| 11 | 5.5m | 1,024.0 | 913.8 | 0 | 13,655 | 109.6 | 50.4 | 6,068 |
| 12 | 6.0m | 1,024.0 | 909.1 | 0 | 13,714 | 109.7 | 49.6 | 6,133 |
| 13 | 6.5m | 1,126.4 | 988.7 | 0 | 14,880 | 110.2 | 50.1 | 6,836 |
| 14 | 7.0m | 1,945.6 | 1,843.2 | 0 | 17,884 | 120.8 | 47.6 | 8,006 |
| 15 | 7.5m | 1,945.6 | 1,843.2 | 0 | 17,942 | 96.9 | 46.0 | 8,036 |
| 16 | 8.0m | 1,945.6 | 1,843.2 | 0 | 18,040 | 104.6 | 47.6 | 8,075 |
| 17 | 8.5m | 2,560.0 | 2,355.2 | 0 | 19,128 | 225.1 | 54.4 | 8,200 |
| 18 | 9.0m | 5,427.2 | 5,222.4 | 0 | 27,651 | 264.8 | 129.5 | 9,345 |
| 19 | 9.5m | 6,348.8 | 499.0 | 5,734.4 | 32,287 | 116.1 | 47.7 | 9,969 |
| 20 | 10.0m | 6,348.8 | 378.2 | 5,836.8 | 32,288 | 115.3 | 48.7 | 9,972 |
| 21 | 10.5m | 6,451.2 | 417.0 | 5,836.8 | 32,401 | 164.3 | 60.8 | 10,013 |
| 22 | 11.0m | 6,451.2 | 449.0 | 5,836.8 | 32,538 | 165.7 | 54.8 | 10,133 |
| 23 | 11.5m | 6,451.2 | 475.2 | 5,836.8 | 32,607 | 141.1 | 53.3 | 10,166 |

Readings this table pins down:

- **Growth is gated on commits.** Samples 5–8: +5 commits, +1.4 MB. Samples
  14–16: +69 commits, +0 MB. Every step coincides with a streaming turn.
- **The dirty-bytes "collapse" at 9.5 m is swap-out, not release**: dirty+swap
  = 6,233 MB and stays; footprint never declines.
- **JS is flat while native explodes.** JS heap peak 129.5 MB (sample 18,
  during the biggest parse churn, GC'd by the next sample); V8 resident peak
  264.8 MB. Both an order of magnitude too small, and the wrong direction.
- **Event-loop lag stays ~4.5 ms** except two blips (29.7 ms at sample 18) —
  the renderer was healthy right up until it wasn't.

### 1.3 The workload (operational log + engine transcript)

Turns from `session.turn.started/completed`; text sizes from the engine
transcript `~/.cat-code/projects/-Users-pt-cat-code/3f3fa745-….jsonl`
(assistant text+thinking chars):

| Turn | Window (Z) | Dur | Assistant chars | Memory step |
|--:|---|--:|--:|---|
| 1 | 05:17:49–05:19:14 | 85 s | 18,455 | +660 MB (samples 1→4) |
| 2 | 05:21:24–05:21:29 | 5 s | 104 | below noise |
| 3 | 05:21:36–05:22:21 | 45 s | 10,036 | +257 MB (9→11) |
| 4 | 05:23:16–05:23:59 | 42 s | 7,189 | +922 MB (12→14) |
| 5–7 | 05:24:09–05:25:22 | 6+6+3 s | ~730 | flat (14→16) |
| 8 | 05:25:34–05:26:26 | 51 s | 14,792 | **+4,403 MB** (16→19) |
| 9–13 | 05:27:31–05:29:45 | 3–15 s | ~2,200 | ~+100 MB tail |

Totals: ~53.5 KB assistant text + ~1.7 KB user text ≈ **55 KB streamed**, for
**6.4 GB retained** — ~120,000 bytes of native memory per streamed byte.

Per-commit cost by turn (memory step ÷ commits in the window):

| Turn | Commits | Per-commit native cost |
|--:|--:|--:|
| 1 | ~3,450 | ~0.19 MB |
| 3 | ~2,112 | ~0.12 MB |
| 4 | ~1,873 | ~0.49 MB |
| 8 | ~1,894 | **~2.3 MB** |

The escalation is the load-bearing observation: per-commit cost grows with the
*accumulated session content*, not with the current turn's size (turn 8
streamed less than turn 1 but cost 12× more per commit). Whatever allocates is
(a) per commit, (b) proportional to total transcript, (c) never freed.

### 1.4 The wire (delivery traces, launch `32bfb0ab`)

11,880 `stream_event` frames traversed every stage
(`sidecar.socket.sent → … → renderer.state.queued`); **11,457 reached
`renderer.state.applied`** (the rest coalesced), against 10,353 total
`rendersCommitted` — commits track applied frames ~1:1. Applied-frame rate in
30 s buckets peaks at 1,717 / 1,665 / 1,615 / 1,460 (≈ 40–57 frames/s during
bursts), which matches Codex-path streaming delta cadence. The wire is
delta-shaped and healthy; nothing here re-sends accumulated state.

---

## 2. The allocation fingerprint

### 2.1 Full vmmap of the live failed renderer

The renderer survived the run (6.6 G footprint, mostly swapped out, RSS
~256 MB). A full per-region `vmmap 87508` (~12:59 local, 40,889 lines) — a
read-only probe, per the incident playbook — decomposes `Memory Tag 253`
(PartitionAlloc; tag constants documented in
`app/scripts/rendererMemoryTrajectory.ts:38`):

By protection state:

| Prot/share | Regions | Virtual | Dirty | Swapped |
|---|--:|--:|--:|--:|
| `rw-/rwx SM=PRV` (committed) | 22,801 | 11,606.6 MB | 33.0 MB | **6,600.6 MB** |
| `---/rwx SM=NUL` (reserved) | 10,673 | 21,150.0 MB | 0 | 0 |

Committed regions by size class (dirty+swapped = live bytes):

| Class | Count | Live bytes | Note |
|---|--:|--:|---|
| **4208K direct maps** | **2,337** | **4,888.2 MB** | per-region used: 2144K ×1,710 · 2128K ×466 · 2160K ×157 · 2112K ×3 — a ~2,144K payload ± 48K |
| 64K spans | 10,417 | 592.3 MB | **≈ 1 per commit** (10,353 commits), ~58 KB used each |
| 192K spans | 2,237 | 407.0 MB | |
| 112K spans | 2,589 | 279.1 MB | |
| 160K spans | 1,633 | 231.7 MB | |
| 16K spans | 3,362 | 52.5 MB | |
| everything else | ~200 | ~110 MB | |

Sum ≈ 6.45 GB ≈ the footprint. For contrast: `Memory Tag 255` (V8) held
116.2 MB dirty + 5.5 MB swapped in 1,421 regions; `Memory Tag 254` (Chromium)
12.9 MB. There is no tag-252 (BlinkGC) row in this Electron build — Oilpan
does not confound the attribution.

What the shape says before any code is read:

- Counts scale with **commits**, not content volume (64K class literally 1:1).
- The dominant class is a **fixed-size repeated allocation**. A growing
  structure would be one huge region; 2,337 identical ~2.1 MB objects is
  "something allocates a ~2.1 MB payload again and again and keeps every one."
- A PartitionAlloc direct map (allocation > ~960 KB) reserves ~2 MB-aligned
  address space around the payload — hence 4208K virtual for ~2,144K used.
- The mid-size classes (112–192K) are the same population at earlier
  transcript sizes: as the per-commit payload grows it crosses PA size-class
  boundaries, which is why the *rate* of 4208K regions escalates across turns
  while its *size* stays put. Turn-arithmetic check: turns 4+ contributed
  ~4,220 commits; 2,337 direct maps + mid-size classes ≈ commit counts of the
  matching windows.

### 2.2 Idle controls on the same process

- `rendersCommitted` froze at 10,353 at 05:30:35 (health samples continue past
  05:38 — the renderer did not die during the measured window; the brief's
  `exitCode=5` was the *prior* launch's DevTools kill at 05:12:09).
- Idle vmmap summary at 12:45:02: tag-253 regions 33,474 vs 33,509 at the full
  capture — **zero growth in hours of idle**, slight decommit. Whatever
  allocates, allocates only when commits happen; whatever retains, retains
  regardless of GC (multiple major GCs visibly ran — V8 resident sawtooths in
  §1.2 — and reclaimed none of it).

---

## 3. Candidate mechanisms and how each died

The brief demanded discrimination between candidates. Final ledger:

| Candidate | Verdict | Killed by |
|---|---|---|
| Unbounded mounted DOM (virtualization silently off live) | **No** | Harness under real layout mounts low-hundreds of nodes while leaking (§6); also 55 KB fully mounted cannot reach 6.4 GB |
| `rehype-highlight` re-tokenization per token (the brief's lead) | **No** (as JS cost it is real; as the *memory* it is nothing) | V3: leak identical with highlighting off; V6: plan-only (highlight on, nothing mounted) also leaks only via measures; JS churn is GC'd, V8 flat |
| hast-tree churn / unified reparse per token | **No** | Same V6/V3 pair; jsHeap flat at ~50 MB throughout |
| ResizeObserver lifecycle (1,900 constructions / 2,000 commits observed!) | **No** | V2: all observers stubbed with no-ops, leak unchanged |
| Per-token `components` map remounts (TranscriptView `useMemo([content])`) | **No** (it is real churn, §11) | V4: stable components, leak unchanged |
| Windowing machinery (spacers, window slide, measurement maps) | **No** | V5: full mount without `BoundedMarkdown`, leak unchanged |
| Forced layout per commit (`scrollHeight` read + `scrollTop` write) | **No** | V9: no layout reads/writes, leak unchanged |
| `console.timeStamp` (46 call sites in dev react-dom) | **No** | P3: stubbed, still floor-flat once measures also stubbed |
| React commit machinery per se / raw DOM mutation / IPC / delivery pipeline / Electron specifics | **No** | P4: React removed entirely, raw DOM writes at same cadence → floor; the harness has no IPC/preload/Electron-app code at all and still reproduced with measures on |
| MessageChannel/postMessage volume (harness pump; scheduler) | **No** | C0: pump spinning at full rate, zero commits → flat |
| **React dev `performance.measure` details (component performance track)** | **YES** | Every variant with the API live ends 25–85 MB above the floor; every variant with it stubbed ends at the floor, including the full real pipeline (P1); buffer directly observed (§8); source confirmed (§9) |

---

## 4. Reproduction harness

### 4.1 Why a harness

Launching the Electron app is a GUI action on the operator's machine
(authorization per run), and DevTools on a loaded renderer is a mutating probe
that has killed the patient twice. The causal work therefore ran in a
disposable page in the in-app Browser pane — a separate Chromium whose
renderer can be measured from outside with `vmmap` and crashed with zero cost.

### 4.2 Architecture (scratchpad-only; zero repo files touched)

Three files (`index.html`, `main.tsx`, `vite.config.ts`) served by the app's
own Vite binary on port 5199 (5173 is the operator's dev app). The page
imports the **real modules by absolute path**:
`app/renderer/src/BoundedMarkdown.tsx`, `markdownRenderPlan.ts`,
`markdownPlugins.ts` (`REHYPE_PLUGINS`), with react/react-dom aliased into
`app/node_modules` — the harness executed the **identical
`react-dom-client.development.js` 19.2.7 file** the dev app loads. A driver
streams a deterministic prose-plus-`ts`-fence document into a pane-shaped
`overflow:auto` scroller (mirroring `App.tsx:4618`) at ~35–45 commits/s,
multiple sequential turns, with stick-to-bottom writes, and an on-page HUD
reporting mounted node counts and options.

Vite config gotchas (each cost one round): the config cannot `import 'vite'`
when it lives outside a package (export a plain object); react must be in
`optimizeDeps.include` for CJS interop; `esbuild: { jsx: 'automatic' }` for
the harness's own TSX.

URL-parameter matrix, each independently killable:
`highlight=0` (no rehype-highlight) · `remap=0` (stable components identity)
· `window=0` (mount the full document, no `BoundedMarkdown`) · `dom=0` (run
`planMarkdownLeaves` per token, mount nothing) · `parse=0` (no unified at
all, render one `<div>{length}</div>`) · `stick=0` (no scroll reads/writes) ·
`react=0` (no React: raw `textContent`/`setAttribute` writes) · `write=0`
(driver runs, zero DOM writes) · `noobs=1` (ResizeObserver no-op stub) ·
`nomeasure=1` (**`Performance.prototype.measure`/`mark` → no-op, installed
before module evaluation**) · `noct=1` (`console.timeStamp` → no-op) ·
`grow=0`, `hz=`, `chars=`, `perturn=`, `turns=`.

### 4.3 The hidden-tab problem

The Browser pane tab is `visibilityState: "hidden"`: rAF **never fires**,
timers are throttled to 1 Hz, and paint never happens. Two failed fixes and
the working one:

- A silent `AudioContext` (gain 0) does **not** lift throttling in this
  Chromium — it reports `running` but ticks stayed at 1/s. Chromium detects
  silence; only *audible* audio exempts a page, which is not acceptable on the
  operator's machine.
- The working driver is a **`MessageChannel` postMessage pump**: a
  self-posting task loop (unthrottled by design) with wall-clock-gated
  callbacks, plus a `requestAnimationFrame` shim that delegates to the pump at
  16 ms while hidden. Cost: one busy core while running; bounded by run
  length.
- Consequence for fidelity: **paint/raster is absent from the harness**.
  Layout still ran (forced by `scrollHeight`/`getBoundingClientRect` reads).
  Since the leak reproduced without paint, paint is not in the causal chain —
  which the app's visible-and-painting failure then cannot contradict.

### 4.4 Measuring the pane renderer

The pane's renderer is found as the youngest `Electron Helper (Renderer)`
after `tabs_create` (note: a same-origin reload keeps the process; only
closing the tab and opening a new one yields a fresh renderer — this matters
in §5). Metric sampler:

```bash
vmmap --summary <pid> | awk '/^Memory Tag 253 /{print $6, $7, $NF}'
# → dirty, swapped, region-count for the PartitionAlloc tag
```

---

## 5. Two measurement traps (they produced wrong verdicts here first)

**Trap 1 — PartitionAlloc span reuse makes region counts lie on a reused
renderer.** After a page reload frees the old document, PA keeps the reserved
super pages and reuses their freed spans. A genuine leak in the next run then
shows **zero region growth** until the reusable pool is exhausted. Inside this
investigation, an instrumented re-run of the leaking baseline showed
`+1 region` and was nearly read as "instrumentation suppressed the leak." The
app never reloads its document, which is exactly why *its* region count grew
monotonically 897 → 32,607. Rule: region counts are evidence only on a fresh
process; the cross-run metric is tag-253 **dirty+swapped bytes**.

**Trap 2 — the reload floor.** A freshly reloaded harness page re-grows to a
**~105–116 MB tag-253 floor** (module fetch/compile/steady-state) within
~30–40 s regardless of workload. Mid-investigation, three "leaking" variants
were actually just re-reaching the floor: their growth **stopped at the floor
mid-run** while ticks continued — the give-away that separates warm-up from
leak. Rule: judge **end states against the floor**, demand growth that
continues past it, and prefer fresh renderers per variant.

Related, smaller: `performance.clearMeasures()` frees only a fraction of
dirty immediately (~12 MB of ~15–18 MB attributable in the trivial variant) —
freed clone buffers land on PA freelists and the pages *stay dirty* until
decommit. **Prove causality by prevention (stub before load), not cure.**

---

## 6. The harness runs, complete

All values are tag-253 `dirty / swapped MB (regions)`. First process
(pid 93942) was reused across V1–V10 (Trap 1/2 apply; region columns there are
reuse-polluted and floor applies to dirty). C/P-series used fresh or
freshly-reloaded processes with the corrected protocol.

### 6.1 First reproduction (fresh process, baseline options)

4 turns × 18,000 chars at ~35 commits/s (~103 s): footprint 83 → ~435 MB;
tag-253 regions 2,082 → 5,511, monotonic during streaming, **dead flat after
DONE**. End-state histogram of the same process: 64K ×2,322 (132.2 MB),
192K ×401 (67.5), 160K ×492 (64.8), 112K ×361 (33.8), 16K ×433 (6.8) — the
**same span classes as the app**, count ≈ 0.65/commit. The ~2.1 MB direct-map
class did not appear because harness props are 12–36 KB; in the app the
analogous payloads are transcript-scale (§10).

### 6.2 Variant matrix (3 turns × 12,000 chars, ~2,000 commits each)

| Run | Options | t0 | t70 | idle | Δ over floor | Verdict |
|---|---|--:|--:|--:|--:|---|
| V1 | baseline, counters on | 58.5/2.8 | 173.9/8.8 | 171.8/8.8 | +65–70 | leaks |
| V2 | `noobs=1` | 73.4/3.6 | 143.6/52.0 | 143.2/51.9 | +80 | leaks — RO out |
| V3 | `highlight=0` | 64.6/6.2 | 186.5/5.7 | 185.7/5.7 | +78 | leaks — hljs out |
| V4 | `remap=0` | 62.2/5.5 | 186.3/5.6 | 166.5/23.9 | +77 | leaks — remap out |
| V5 | `window=0` | 62.3/5.8 | 184.7/5.2 | 192.1/5.2 | +84 | leaks — windowing out |
| V6 | `dom=0` | 65.1/5.2 | 174.5/5.1 | 181.2/5.1 | +73 | leaks — mounting not needed |
| V7 | `parse=0` | 58.9/10.2 | 130.5/9.8 | 130.7/9.8 | +27 | small leak — small props |
| V9 | `parse=0 stick=0` | 66.8/4.9 | 115.1/21.9 | 104.9/35.7 | +27 | small leak — layout out |
| V10 | `hz=2` (140 commits) | 65.6/7.5 | 90.1/7.6 | 93.8/7.6 | ~floor | few commits, little leak |
| C0 | fresh pid, zero commits, pump spinning | 104.6/0 | 108.2/0 | — | 0 | **flat — pump/HUD out** |
| C1 | fresh pid, trivial commits, measures live | 56.9/0 | 108.4/18.0 | 111.9/18.0 | +15–25 | leaks (small props) |
| P1 | **fresh pid, `nomeasure=1`, FULL pipeline** | 27.7/0 | 107.8/0 | 104.8/8.3 | **0 (floor)** | **no leak** |
| P2b | `nomeasure=1 parse=0 stick=0` | 52.2/1.7 | 105.3/8.0 | 105.4/8.0 | 0 | no leak |
| P3 | + `noct=1` | 48.3/1.8 | 114.8/1.8 | 115.5/1.8 | 0 | timeStamp out |
| P4 | `react=0` raw DOM writes | 42.4/1.8 | 114.8/1.8 | 114.8/1.8 | 0 | React/DOM out |
| P6 | `react=0 write=0` slice-only | 49.3/2.4 | 108.8/4.1 | 105.2/10.8 | 0 | driver out |

The single causal lever across all sixteen runs is the measure API. With it
live, end state scales with how much prop content the variant's components
carry (full pipeline ≈ +80, trivial props ≈ +25). With it stubbed, everything
— including the complete real pipeline — lands on the floor. P1 was verified
to have recorded **zero** measures (`getEntriesByType('measure').length === 0`,
stub identity confirmed) while executing the identical workload.

---

## 7. Direct observation of the buffer

On C1 (trivial props, measures live), after ~2,000 commits:

- `performance.getEntriesByType('measure').length` = **1,728**.
- Names: `Update` ×959, `​MessageBody` ×760 (React's zero-width-space
  performance-track prefix), `Mount` ×6, `Update Blocked` ×3.
- Sampled `MessageBody` measures each carried a `detail` whose JSON
  serialization measured **23,757 and 23,875 bytes** — against a 12–36 KB
  `source` prop. The detail embeds the changed props (the whole string), plus
  per-field entries.
- `performance.clearMeasures()` dropped tag-253 dirty+swap from 129.8 to
  118.2 MB immediately (see Trap 3 for why the rest lingers on freelists),
  and the page's entry list went to ~0.

Instrumented counters from the same run (native-API census wrapper): 1,900
`new ResizeObserver` + 1,891 `disconnect()` per ~1,970 commits (§11.1), DOM
adds/removes ~2,350 each (~1.2/commit — React reconciles in place; mass
remount is *not* happening), attribute changes ~2,299 (~1.2/commit).

---

## 8. Source anatomy

### 8.1 React (`react-dom-client.development.js` 19.2.7)

- `logComponentRender` (~line 4096): for every fiber with a resolvable
  component name, computes self-time, picks a track color, and **when props
  changed** (`null !== props && null !== alternate && alternate.memoizedProps
  !== props`) builds `child = [reusableChangedPropsEntry]` and
  `addObjectDiffToProperties(alternate.memoizedProps, props, child, 0)`, then
  emits the measure — via `fiber._debugTask.run(performance.measure.bind(
  performance, '​' + name, fiber))` when a debug task exists, else
  directly. The reused options object carries
  `detail: { devtools: { color, track: COMPONENTS_TRACK, trackGroup,
  tooltipText, properties } }` (assembly ~line 25542,
  `reusableComponentDevToolDetails`). The object is *reused* per call, but the
  clone happens at `measure()` call time, so every call stores an independent
  serialization.
- Error and effect paths (~4211, ~4260) serialize `fiber.memoizedProps`
  **whole** via `addObjectToProperties`.
- `addValueToProperties` — the serializer — has **no length truncation**:
  strings are embedded in full; primitive arrays are `JSON.stringify`'d whole;
  objects expand into one `[indent-prefixed name, stringified value]` entry
  per nested field (the `  `-repeat indentation strings are part of
  the expansion factor); React elements render as `<Name … />` summaries;
  promises are unwrapped. The only `.slice(` calls in the entire file are
  5-char attribute-name prefixes.
- Census: 17 `performance.measure` call sites, 46 `console.timeStamp` call
  sites (the latter exonerated empirically — P3). Gate:
  `supportsUserTiming`, i.e. `typeof performance.measure === 'function'`.
  **There is no React-side buffer management, clearing, cap, or opt-out** in
  the stable dev build.

### 8.2 Chromium (User Timing L3)

`performance.measure(name, { detail })` runs **StructuredSerialize on the
detail synchronously at call time**; the `PerformanceMeasure` entry retains
the serialized buffer (deserialized lazily on `.detail` access). Marks and
measures are exempt from the resource-timing buffer cap; entries accumulate on
the per-document performance timeline until navigation or explicit
`clearMeasures()`. With PartitionAlloc-everywhere, the serialization buffers
are PA allocations → vmmap tag 253. This is why `jsHeapUsedBytes` (peak
129.5 MB), V8 residency, and any JS heap snapshot were all blind to 6.3 GB.

A payload of ~2,144K ± 48K per clone at transcript scale, rounded into PA's
direct-map granularity, produces exactly the observed 4208K × 2,337 class;
payloads of tens-to-hundreds of KB produce the 64K–192K span classes, 1:1
with commits for the ubiquitous small measures.

---

## 9. Why streaming is the worst case

Three multipliers compound, all measured:

1. **Commit rate.** Codex-path streaming applies 40–57 frames/s → ~45
   commits/s (11,457 applied ≈ 10,353 commits).
2. **Per-commit payload ∝ accumulated content.** The streaming message's
   `content` prop changes every token, so its component (and every ancestor
   whose props embed transcript state) re-renders and gets a props-diff
   measure containing the ever-longer strings/arrays. This is the escalation
   in §1.3's table and the size-class migration in §2.1.
3. **Nothing ever unloads.** The desktop app is a long-lived SPA document.
   No navigation, no `clearMeasures()`, no consumer of the entries at all —
   the buffer only ever grows. (Closing session tabs inside the app does not
   help: same document, same timeline. This is also why the 2026-08-14
   tab-close experiment freeing 3.2 GB proves that *that* incident's memory
   was mounted DOM, not measures — see §12.)

The short turns 2, 5–7, 9–13 (a few seconds, a few hundred chars each) added
almost nothing — few commits, small diffs — which is why the failure
historically looked like "long streaming turns kill the renderer."

---

## 10. Reconciliation arithmetic (app run vs mechanism)

| Fingerprint fact (§2) | Mechanism account (§8) |
|---|---|
| 64K spans ≈ 10,417 vs 10,353 commits | one small-detail measure set per commit (`Update`/short component measures, ~58 KB serialized) |
| 4208K direct maps ×2,337, ~2,144K each, rate escalating per turn | transcript-scale props-diff details; count ≈ commits of the later turns whose serialized diff crossed PA's ~960 KB direct-map threshold |
| 112–192K spans ≈ 6,459 | the same payload population during earlier/mid turns |
| per-commit cost 0.19 → 2.3 MB across turns | serialized props grow with accumulated transcript |
| flat during idle, no GC recovery, ever | entries are live document-lifetime objects, not garbage |
| dirty converges on footprint; survives swap-out untouched | committed clone buffers, never re-read |
| V8/JS flat throughout | clone storage is native; the JS detail objects are transient and GC'd |
| 55 KB text → 6.4 GB | per-field expansion × whole-string embedding × ~10⁴ commits, integrated quadratically |
| total: 592 MB + ~920 MB + 4,888 MB + misc ≈ 6.45 GB ≈ footprint | the three classes are one mechanism at three payload sizes |

---

## 11. Side findings (not the leak; do not lose these)

1. **`BoundedMarkdown`'s per-leaf ResizeObserver effect rebuilds nearly every
   token.** Measured: 1,900 observer constructions + 1,891 disconnects per
   ~1,970 commits. The design comment (`BoundedMarkdown.tsx:80-83`) says
   keying on `mountedKeys` (identity, not revision) avoids exactly this;
   empirically the mounted-key string changes almost every streamed token
   during fence growth (leaf boundaries move / leaves appear). V2 proved this
   churn is *not* the memory mechanism, but it is per-token native object
   churn and re-observation work the design intended to avoid, and worth its
   own small session. It also retroactively explains why `45-F4`-style
   observer-hygiene proofs kept feeling load-bearing.
2. **`TranscriptView`'s `components` map is minted per token**
   (`useMemo` keyed on `[content, openFile]`, ~line 926): four fresh component
   types per streamed token force React to remount every
   blockquote/p/li/inline-code in the mounted window on every token. Harness
   counters put the resulting DOM churn at only ~1.2 adds/commit in the
   fence-dominated workload (spans reconcile in place), so it is cheap today —
   but it is a standing re-render amplifier for prose-heavy streams, and V4
   shows removing it is behavior-neutral.
3. **The measured mounted-DOM claim now has live-layout evidence.** Under real
   Chromium layout (harness, real rects, working window selection), total
   document nodes stayed in the low hundreds across multi-turn streaming —
   the first non-happy-dom confirmation that the CC-59 window actually bounds
   mounted DOM. (Still not the app itself; the app-side NOT MEASURED verdicts
   in the trajectory tool remain NOT MEASURED.)
4. **Hidden-tab facts** for future in-pane work: silent `AudioContext` does
   not unthrottle; a MessageChannel pump does; rAF must be shimmed; paint
   never runs, so paint-side mechanisms cannot be tested in the pane.
5. **Engine-side observation, unrelated to the renderer:** the 13-turn session
   spawned 67 engine subprocesses (44 `sessions-catalog`, 22 `accounts-pool`)
   per the operational log — worth a glance from whoever owns engine process
   hygiene.
6. The app's own trajectory tooling behaved exactly as designed
   (`healthAgeMs` pairing, swap column, PA tagging); the vmmap tag table in
   `rendererMemoryTrajectory.ts` is correct and was the key instrument.

---

## 12. Reconciliation with the prior record

- **2026-08-14 attribution stands for its own incident.** In that two-session
  read-heavy workload, closing both tabs dropped PA 3.6 GB → 444 MB. Measure
  clones would *not* free on in-app tab close (same document); mounted DOM
  does. That incident was DOM-dominated; virtualization addressed it. The
  measure term was present but secondary there, and became dominant — and
  fatal — for streaming workloads once the DOM term was bounded.
- **2026-08-09 SIGTRAP** (PA OOM during selection-bounds shaping) and the
  **2026-08-16 05:12 DevTools kill** (`Debugger.enable` re-parse OOM) are both
  "a small allocation failed inside a renderer already saturated by this
  mechanism," not independent leaks.
- **The 2026-08-14 renderer freeze remains open and untouched** by this
  report. Nothing here explains a frozen `<App>` with flat memory; do not
  conflate the two (the incidents-final report's §3 warning stands).
- The observability lesson repeats: every in-app metric was blind or merely
  correlative; external `vmmap` tag histograms plus `rendersCommitted` were
  the discriminating pair — exactly the §7 playbook pairing, now with a
  worked example.

---

## 13. Not established

- **The app renderer was never probed directly** (the DevTools ban on a
  loaded renderer stands; the 6.6 G renderer was left untouched). In-app
  attribution rests on: identical react-dom dev bytes loaded by app and
  harness, the §10 arithmetic, and the harness stub proof. The closing
  observation is cheap (§15).
- **Which app component mints the ~2.1 MB details** is inferred from size
  (a pane/transcript-level component whose props carry row arrays), not
  observed by name.
- The tight ~2,144K clustering is read as "serialized transcript-scale
  properties at this workload, rounded by clone-buffer growth"; Blink's exact
  buffer-capacity policy was not traced.
- Harness Chromium ≠ Electron 33.4.11 and the harness page never paints; both
  caveats are mitigated by the fingerprint match against the app's own vmmap
  and by paint being absent from the causal chain.
- V2's stubbed-RO run showed a larger *swapped* share than siblings — noted,
  unexplained, immaterial to the verdict (totals matched).

---

## 14. Fix directions (deliberately unimplemented — operator scoped this to investigation)

Dev-runtime-only, cheapest first:

1. **Stub or filter `performance.measure`/`mark` in the dev renderer entry
   before React loads** — drop the `detail`, or drop measures whose name
   starts with `​`. Proven leak-free in P1 with the full real pipeline.
   Cost: loses the DevTools "Components" performance track nobody here uses.
2. **Bound the buffer**: periodic `performance.clearMeasures()` +
   `clearMarks()` (e.g. on `session.turn.completed`). Footprint stabilizes
   rather than shrinks (freed pages are reused, not returned).
3. **Serve production React in dev** (Vite alias/define). Removes the whole
   dev instrumentation family; costs dev warnings and component stacks.
4. **Upstream issue to React**: the component performance track accumulates
   unbounded User Timing entries with uncapped props serialization; any
   long-lived dev session with frequent commits and large props will OOM its
   renderer. This report's numbers (55 KB in → 6.4 GB retained) make a crisp
   reproduction case. A matching Chromium-side note (measure details are
   unbounded native memory invisible to every JS metric) may also be worth
   filing.

Acceptance for any fix: re-run `bun run --cwd app memory:trajectory`
single-turn workload — footprint must stop tracking `rendersCommitted`, and
the `curve-not-accelerating` and `region-growth-final-window` verdicts must
pass where they failed on 2026-08-16. The 750 MB single-turn ceiling should
follow.

---

## 15. Operator verification procedure (closes §13's first gap)

On a **fresh** dev launch (attach-at-launch is safe; the ban is attaching to a
*loaded* renderer):

1. Launch the dev app with DevTools already open on the renderer.
2. Stream one moderate turn (a few thousand tokens).
3. In the console: `performance.getEntriesByType('measure').length` — expect
   it to track `rendersCommitted` (thousands after one streamed turn), names
   prefixed `​`.
4. `const ms = performance.getEntriesByType('measure');
   ms.filter(m => m.name === '​<suspect>').at(-1)?.detail` — identifies
   the transcript-scale component and its serialized props by inspection.
5. Optional: `performance.clearMeasures()` and observe the footprint plateau
   on the next `memory:trajectory` window.

---

## 16. Appendix: methodology commands

```bash
# External renderer measurement (playbook §7.6):
vmmap --summary <renderer-pid>      # tag rows; $6 dirty, $7 swapped, $NF regions
vmmap <renderer-pid> > full.txt     # per-region; histogram the "Memory Tag 253" rows

# PA tag constants (Chromium PageTag): 252 BlinkGC · 253 PartitionAlloc ·
# 254 Chromium · 255 V8 — documented in app/scripts/rendererMemoryTrajectory.ts:38.

# Size-class histogram from a full vmmap (BSD awk):
awk -F'[][]' '/^Memory Tag 253/ { prot=$3; gsub(/^ +/,"",prot);
  if (prot !~ /^rw-\/rwx SM=PRV/) next; split($2,f," ");
  cnt[f[1]]++; }
  END { for (k in cnt) print k, cnt[k] }' full.txt

# Commit/turn correlation from the app's own records:
jq -r 'select(.event=="renderer.health.sample") |
  [.timestamp, .fields.rendersCommitted] | @tsv' operational-<launch>.jsonl
jq -r 'select(.event|test("session.turn")) |
  [.timestamp, .event, (.fields|tostring)] | @tsv' operational-<launch>.jsonl

# Applied-frame cadence, 30s buckets:
cat delivery-trace-<launch>-*.jsonl |
  jq -r 'select(.stage=="renderer.state.applied") | .wallTimestamp[11:19]' |
  awk -F: '{printf "%s:%02d\n", $1":"$2, int($3/30)*30}' | uniq -c

# Streamed content sizes from the engine transcript:
jq -r 'select(.type=="assistant" or .type=="user") |
  [.timestamp[11:19], .type, ((.message.content//[]) |
   if type=="array" then (map(if .type=="text" then (.text|length)
     elif .type=="thinking" then (.thinking|length) else 0 end)|add)
   else (tostring|length) end)] | @tsv' <engine-session>.jsonl
```

Harness load-bearing snippets (full copies lived in the session scratchpad;
recreatable from §4):

```ts
// Unthrottled driver for a hidden tab: MessageChannel pump, wall-clock gated.
const channel = new MessageChannel()
let entries: Array<{ at: number; fn: (now: number) => void }> = []
channel.port1.onmessage = () => {
  if (entries.length === 0) return
  const now = performance.now()
  const due = entries.filter(e => e.at <= now)
  if (due.length) { entries = entries.filter(e => e.at > now); for (const e of due) e.fn(now) }
  channel.port2.postMessage(0)
}
// rAF shim while hidden: pump.schedule(16, cb). Driver: pump.schedule(1000/hz, tick).

// The causal stub (prevention proof), installed before react-dom evaluates:
Object.defineProperty(Performance.prototype, 'measure', { value: () => undefined })
Object.defineProperty(Performance.prototype, 'mark',    { value: () => undefined })
```

## 17. Appendix: evidence artifacts

Durable:

- `app/.ram-scratch/trajectory/single-turn-2026-08-16T05-17-11-883Z.run.json`
  (+ `.summary.txt`) — the measured failure (all §1.2 numbers).
- Operational log + delivery traces for launch `32bfb0ab`, and the preserved
  prior-occurrence set for `ee7d59cd` (101 MB), under
  `~/.cat-code/desktop/logs/` and the dispatch brief's scratchpad copy.
- Engine transcript
  `~/.cat-code/projects/-Users-pt-cat-code/3f3fa745-d864-4bae-b64f-9bb80119161c.jsonl`.
- `app/node_modules/react-dom/cjs/react-dom-client.development.js` 19.2.7 —
  source anchors in §8 (`logComponentRender` ~4096, error paths ~4211/4260,
  detail assembly ~25542).

Session-scratchpad (ephemeral, session `5d4a371d`, contents summarized fully
in this report): `vmmap-full-87508.txt` (§2 source), `vmmap-harness-baseline.txt`,
per-variant sample logs (`harness-*-samples.txt`), `pa253.sh`, and the harness
(`cc59-harness/index.html`, `main.tsx`, `vite.config.ts`).

---

## 18. Resolution (appended 2026-08-16, after the operator authorized the fix)

**§14 option 1 is implemented and confirmed in the app.** `eda3055e`:
`app/renderer/src/reactDevPerformanceTrack.ts` wraps `performance.measure`,
drops calls carrying React's `detail.devtools` payload, and forwards every
other caller untouched. Installed from `app/renderer/src/main.tsx` behind
`import.meta.env?.DEV`; `renderer:build` then confirmed zero occurrences in
`renderer/dist`, so packaged builds are byte-unchanged.

The filter keys on `detail.devtools` rather than the `​` name prefix
(§14's alternative): every React measure call site passes a reusable options
object carrying that payload, and the payload is the thing being cloned, so it
identifies the calls and the cost together. `performance.mark` needed no
handling — the dev bundle contains no `performance.mark` call sites.

### 18.1 The mechanism now has a test, not a description

`app/renderer/src/reactDevPerformanceTrack.dom.test.ts` drives the real
`react-dom/client` commit path under the existing happy-dom harness.
`supportsUserTiming` is true there (both `console.timeStamp` and
`performance.measure` are functions), so React really instruments.

Six renders of one component produced **12 retained measures**, every one
carrying `detail.devtools`, named `Update`, `Mount`, `Update Blocked`,
`Cascading Update` and `​<ComponentName>` — the §7 population, reproduced
in-repo. The component's full prop string appears **verbatim and uncapped**
inside a retained entry, which is §8.1's `addValueToProperties` claim promoted
from source reading to executable evidence.

That baseline assertion is the load-bearing half: if React ever stops
serializing props, it fails loudly instead of leaving the filter silently
guarding nothing. Mutating the predicate fails 4 of the 7 tests across both
new files.

### 18.2 §13's first gap is closed

The app renderer had never been probed. It has now been measured
behaviourally, by a different route than §15 prescribed: the operator declined
DevTools, so the renderer was sampled by external `vmmap` from a second
terminal against a fresh dev launch (`bun run --cwd app dev`, Vite on :5173,
no packaged-branch warning, so the dev branch is proven live).

| | Failing run (05:17) | Confirming run (16:35–17:06) |
|---|---:|---:|
| Duration | 11.5 min, died | 31 min, healthy |
| Sessions | 1 pane | 3 panes, 2 resumed (273 and 38 messages) |
| First sample | 154 MB | 161.8 MB, released to 79 MB |
| Final | 6,451 MB, PA OOM abort | 120.2 MB |
| Peak | 6,451 MB | 194.9 MB, during the *light* phase |
| Heavy fenced-code turns | turn 8 alone: +4,600 MB | 4 turns over 16 min, peak 138.8 MB |
| Reclamation | none, ever | repeated: 194.9→119.2, 138.8→118.4, 138.4→120.2 |

The trailing five minutes are flat (120.1, 120.1, 120.1, then 110–138 with no
trend), so `curve-not-accelerating` and `region-growth-final-window` both pass
where they failed on 2026-08-16, and the 750 MB single-turn ceiling follows by
a wide margin.

Two properties matter more than the totals. **Memory is released repeatedly**,
which the failing run never did once (§2.2: plateaus flat, tag-253 regions
crept by zero). And **the per-commit cost no longer escalates** — §1's table
climbed 0.18 → 2.5 MB per commit across turns, whereas here four heavy
fenced-code turns peaked *lower* than the earlier light ones. The confirming
workload was harder than the fatal one on every axis.

### 18.3 This run discriminates against the competing mechanism

`2026-08-16-cc59-blink-native-memory-gpt-5.6-sol.md` attributes the growth to
whole-value `nodeValue` replacement, LayoutNG replace-all invalidation, and
full-node reshaping, and prescribes restructuring the streaming render path.

This fix touches none of that. Every text replacement, layout invalidation,
reshape and synchronous `getBoundingClientRect` flush still happens on every
commit. The growth is gone regardless. That report proposed a two-fixture
discriminator and did not run it; this is effectively that experiment, and it
went against its verdict.

It is also the second kill, not the first: §3's V9 already removed all forced
layout reads and writes from the harness and the leak was unchanged, and P4
removed React entirely in favour of raw DOM writes at the same cadence and hit
the floor. The confirming run adds the in-app version of the same result.

### 18.4 Still open, unaffected by the fix

- Which component minted the ~2.1 MB details was never observed by name
  (§13). The fix makes the question moot operationally but leaves it unanswered.
- The ~2,144K clone-buffer clustering was never traced to Blink's growth policy.
- **Paint and compositor buffers remain untested by anyone.** The harness page
  was hidden and never painted, so §6's matrix could not see them; the
  companion report named them a plausible secondary contributor. The confirming
  run's flat curve bounds their share as small at this workload, but does not
  measure it.
- `app/sidecar/subagentRestore.probe.test.ts` fails in full-suite runs and
  passes in isolation. Pre-existing and unowned: verified by re-running the
  suite with this work's two test files removed.
