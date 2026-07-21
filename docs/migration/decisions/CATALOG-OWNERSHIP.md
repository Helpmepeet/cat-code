# CATALOG-OWNERSHIP — who enumerates the sessions catalog (RATIFIED: shape b)

**Status: RATIFIED 2026-07-21 — owner = shape (b)** (operator-delegated,
"up to you recommendation"). The SHAPE choice is final and does not reopen a
locked decision (§7); the quantified savings table below still carries
`[RAM-0]` placeholders pending a **decision-grade** RAM-0 run — the SCRATCH
figures are directional only, not pinned. Records the owner
choice for the cross-workspace sessions-catalog enumeration (audit RAM-3.1,
`docs/migration/reviews/2026-07-21-app-cutlist-ram-audit.md`, committed
`6cdb6bc`). Does **NOT** reopen a locked decision — see §7. Numbers below carry
their evidence class: `VERIFIED` (source-anchored, re-checkable) or `SCRATCH`
(single-run sandbox measurement from the audit, not decision-grade). Every place
a real figure is owed is tagged **`[RAM-0]`** and must be filled from the RAM-0
measurement artifact before this draft is ratified. Line anchors are as of
2026-07-21 on `migration`; the tree is multi-writer — re-anchor before executing.

---

## 1. Problem statement (verified mechanism)

The sessions catalog is the cross-workspace list of every resumable engine
transcript (the unified roster ratified by `SESSIONS-UNIFICATION.md`). Today it
is **owned per-sidecar**: every attached engine process independently enumerates
the entire on-disk transcript store and re-broadcasts it on a timer.

Verified mechanism:

- The sidecar arms a 30 s refresh timer at construction —
  `app/sidecar/sidecarServer.ts:443-451`, interval
  `SESSIONS_CATALOG_REFRESH_INTERVAL_MS = 30_000` (`sidecarServer.ts:287`).
  VERIFIED.
- Each tick calls `refreshSessionsCatalog()` (`sidecarServer.ts:2310-2333`),
  which is a **no-op unless a supervisor connection is attached**
  (`connections.size === 0` early-returns, `:2314-2316`) and otherwise runs the
  enumeration and re-broadcasts `sessions.snapshot` (`broadcastSessionsSnapshot`,
  `:2323`). VERIFIED. So the cost is paid by every *attached* sidecar, once per
  30 s, for as long as it lives.
- The enumeration is `loadAllProjectsMessageLogsProgressive`
  (imported `app/sidecar/sessionsCatalogDomain.ts:42-45`, called `:82-85`; the
  same loader `/resume` uses, `src/utils/sessionStorage.ts:4476` per the domain
  header). It stat-lists up to `SESSIONS_CATALOG_STAT_LIMIT = 1000` files per
  project dir (`sessionsCatalogDomain.ts:54`), then enriches the most-recent
  `SESSIONS_CATALOG_ENRICH_LIMIT = 600` (`:62`) with ≤2×64 KB head+tail reads
  each (domain header `:9-16`). Bounded per run — but paid **N times** across N
  attached sidecars, every 30 s. VERIFIED.

Cost (all **SCRATCH**, from the audit — see §4/[RAM-0]): the catalog work adds a
resident plateau of **~230 MB per attached session at enrich=600** (audit
RAM-3.1; attached-idle plateau ~467 MB vs ~237 MB boot floor, ~278 MB at
enrich=50; RAM-1). With N live sessions the fleet pays ~N× that plateau for one
logically-shared list.

### Why "just move enumeration to host/main" is NON-CONFORMING

The naive fix (PER-SESSION-COST.md §"Reducible" item 1: "load the catalog once in
host/main and pass it in") crosses an engine-free trust boundary and cannot be
done as written. VERIFIED against source:

- **The host plane must not import the engine graph.** `app/host/registry.ts`
  is "pure host-plane state … Does NOT import the engine graph (`src/**`)"; the
  two pieces of engine behavior it needs are *re-implemented*, never imported,
  "so the host plane typechecks in isolation and never drags in the Bun engine
  runtime" (`registry.ts:12-20`). `loadAllProjectsMessageLogsProgressive` lives
  in `src/**` — importing it into the host is exactly the forbidden move.
- **Electron main stays engine-free by design, and already has the pattern for
  this.** `main.ts` runs the PL-B transcript-backfill worker precisely so main
  never imports the engine: "The worker reads the engine transcript; main
  remains engine-free and is the single cache writer" (`app/main/main.ts:246-253`).
  Main is a *spawner/consumer* of a disposable engine-graph process, not an
  engine host.
- **The catalog domain's own header says the host cannot enumerate.** "The host
  plane is deliberately engine-free (`app/host/registry.ts:19`), so it cannot
  enumerate transcripts; the sidecar (which runs the real engine) reads them"
  (`app/sidecar/sessionsCatalogDomain.ts:1-8`). VERIFIED.

So the enumeration must run in **a process that is allowed to import the engine
graph**. The question is *which* engine-capable process owns it — not whether to
move the raw loader into host/main.

---

## 2. Conforming owner shapes

Four shapes keep the enumeration inside an engine-capable process without
reopening a locked decision. Each carries its own singleton cost that must enter
the savings table (a single shared owner replaces N per-sidecar copies, but the
owner itself is not free).

- **(a) Main-supervised PERSISTENT Bun catalog worker** — a long-lived
  engine-graph process (the `transcriptBackfillWorker` graph, but resident) that
  enumerates on its own timer and pushes snapshots to main. Always resident.
- **(b) Main-supervised ONE-SHOT worker on a timer** — main re-spawns a
  disposable engine-graph worker every interval, exactly the PL-B
  `runTranscriptBackfill` pattern (`app/main/transcriptBackfill.ts:94`,
  `app/sidecar/transcriptBackfillWorker.ts`). The worker enumerates once, emits
  the catalog as bounded NDJSON, and exits. Near-zero resident between runs;
  repeated boot cost per run. **← operator's lean.**
- **(c) Designated-sidecar publisher** — no new process: one already-live
  sidecar is elected the catalog owner and the others stop enumerating. Needs an
  ownership/failover protocol and a policy for the zero-live-sessions case (no
  sidecar exists to enumerate).
- **(d) Extracted engine-free scanner** — re-implement the *lite* scan in the
  host/main plane the way `registry.ts` already re-implements config-home rules
  and transcript-path encoding (`registry.ts:16-20`). Smallest resident cost; no
  engine import at all; largest drift risk against `src/utils/sessionStorage.ts`.

### Delivery seam (a design input that splits the shapes)

Today the catalog reaches the renderer as a sidecar `sessions.snapshot`
ServerFrame over the session's UDS connection (`sidecarServer.ts:2323`). Shapes
**(a)/(b)/(d)** produce the catalog *off* any sidecar connection, so they need a
new **main/host → renderer delivery seam** — a read-only outbound host event or
host-API read (the existing host event stream: `sendHostEvent`, `main.ts:319`;
renderer subscribes at `App.tsx:653` per the audit). This is additive and
conforms to the C3 read-only-snapshot precedent; it is **not** a renderer-authored
write. Shape **(c)** keeps the existing sidecar broadcast and needs no new seam.

---

## 3. Comparison

| Dimension | (a) persistent worker | (b) one-shot on timer **←lean** | (c) designated sidecar | (d) engine-free scanner |
|---|---|---|---|---|
| New process? | Yes, 1 resident | Yes, 1 transient per run | No | No |
| Resident cost (steady) | Full worker floor, always ~**[RAM-0]** (SCRATCH ~176–237 MB) | ~0 between runs; worker floor only during a run | 0 extra (rides an existing sidecar) | Smallest — host-plane objects only, no engine graph |
| Boot cost | Once (at app start) | **Per run**: ~**[RAM-0]** (SCRATCH ~0.3–1.8 s incl. engine-graph import) | None | None |
| N=1 economics | Owner floor replaces 1 sidecar's plateau — near wash | Owner idle between runs; strictly cheaper than 1 always-enumerating sidecar | Free (the one sidecar was enumerating anyway) | Free |
| N>1 economics | Saves ~(N−1)× per-session plateau **[RAM-0]** for 1 resident floor | Saves ~N× per-session plateau **[RAM-0]**; owner resident ≈ 0 between runs — best fleet economics | Saves ~(N−1)× (one sidecar still pays) | Saves ~N× (no engine-graph copy anywhere for the catalog) |
| Cache freshness | Continuous (own timer) | Bounded staleness = timer interval; **plus** a session created mid-interval is invisible until the next run | Continuous while the owner lives | Continuous (own timer); but lite-scan may lag engine semantics |
| Failure modes | Worker crash → stale catalog until restart; needs a supervise/restart policy | Run fails → keep last good snapshot (the domain already degrades, `sessionsCatalogDomain.ts:112-127`); a run can overrun its interval → needs single-flight guard | Owner sidecar exits/parks → must re-elect; **zero-live-sessions ⇒ no owner ⇒ no fresh catalog** (the launch/all-closed case the catalog most needs) | Scanner bug silently diverges from real resume-ability |
| Drift risk | Low — imports the real loader | Low — imports the real loader | Low — imports the real loader | **High** — a hand-maintained scan drifts from `sessionStorage.ts` enrich/filter rules (hasConversation, sidechain drops, cwd reconciliation — `sessionsCatalogDomain.ts:131-240`) |
| Security posture | Unchanged: worker reads transcripts engine-side, emits display-metadata-only, `secretGuard`-clean by construction (domain header `:35-38`); outbound-secrets posture stays engine-side. | Unchanged (same as a; reuses PL-B's fail-closed NDJSON + `scanForSecrets`, `transcriptBackfill.ts:186`) | Unchanged (existing sidecar broadcast path) | Unchanged for secrets (metadata-only), **but** re-implements the read outside the engine — the drift risk is correctness, not secret exposure |
| Reuses existing machinery? | Partial (worker graph, but new resident-lifetime supervision) | **Yes — the exact PL-B `runTranscriptBackfill` trio** (§5) | Yes (existing broadcast) + new election protocol | No — new scanner code (CLAUDE.md §8 rule 10 hazard) |

Security note (applies to all shapes): the owner reads transcripts, but the
catalog is **display-metadata only — no message bodies, no credentials** — so the
outbound frame is `secretGuard`-clean by construction (`sessionsCatalogDomain.ts:35-38`),
and the engine-side-only outbound-secrets posture is **unchanged** by any shape
here. No new inbound vocabulary is introduced (the catalog is outbound-only), so
the SECURITY-MINIMUM inbound-allowlist tax does not apply; the new delivery seam
for (a)/(b)/(d) is a read-only outbound snapshot (C3 precedent).

---

## 4. Recommendation: shape (b) — main-supervised one-shot worker on a timer

**Recommend (b), matching the operator lean.** Rationale (one paragraph): the
catalog is *fleet-shared, read-only, refresh-tolerant* display metadata whose
cost today is N× a resident enumeration plateau. Shape (b) collapses that to a
**single owner that holds no resident memory between runs** — the best N>1
economics of any conforming shape — while reusing the already-built, already-
hardened PL-B one-shot-worker pattern verbatim (§5), so it introduces no new
machinery (CLAUDE.md §8 rule 10) and inherits PL-B's fail-closed NDJSON boundary,
`secretGuard` re-scan, and "main is the single writer / engine-free" posture. It
strictly dominates the naive move (conforming, not host-side engine import) and
avoids (c)'s ownership/failover protocol and its fatal zero-live-sessions gap —
the catalog is *most* needed at launch and when everything is closed, exactly
when (c) has no owner. It accepts (a)'s job of "own the catalog" but pays a
resident floor only during the brief enumeration, not continuously.

**Honest cons (do not bury):**

- **Repeated boot cost.** Every run re-imports the engine graph and re-parses it
  (~**[RAM-0]**; SCRATCH ~0.3–1.8 s, which includes the ~189 MB engine-code
  import measured in PER-SESSION-COST.md). At a 30 s cadence this is a recurring
  CPU/IO spike, not a memory cost. If it proves too heavy, the cadence is the
  lever (lengthen the interval) — freshness is already refresh-tolerant.
- **Staleness window between runs.** A session created mid-interval is invisible
  until the next spawn completes — up to one interval + one boot. This is *not a
  regression*: today's per-sidecar refresh is also a 30 s timer, and a session
  born after a sidecar spawned is already invisible to it until its next tick
  (`sidecarServer.ts:443-451`, the "spawn-frozen" problem #16 fixed with the same
  30 s refresh). (b) preserves that exact freshness contract with one owner
  instead of N.
- **A run can overrun its interval** under a large corpus — needs a single-flight
  guard so main never spawns a second worker while one is in flight (mirror
  `sessionsCatalogRefreshInFlight`, `sidecarServer.ts:2317-2320`; the PL-B runner
  is already one-serialized-worker, `transcriptBackfill.ts:2-3`).
- **New delivery seam** (main/host → renderer, §2) that shapes (c) avoids.

---

## 5. How (b) reuses the existing PL-B pattern (no new machinery)

Shape (b) is the PL-B transcript-backfill worker with a different payload and a
timer instead of a one-time post-paint trigger. Reuse the **exact** entry points
(VERIFIED); do not invent a parallel worker harness.

- **Runner (main-side, engine-free, unit-testable):**
  `runTranscriptBackfill(options)` — `app/main/transcriptBackfill.ts:94`. It
  spawns exactly one serialized engine-graph worker
  (`spawn(command, args)`, `:111`), streams bounded NDJSON, validates every
  record fail-closed, re-runs `scanForSecrets` (`:186`), and hands accepted
  results to main. A catalog variant is a sibling runner of the same shape (or a
  generalization of it), spawned with the same argv convention
  `['run', <WORKER_ENTRY>, '--bare']` (`main.ts:288-292`).
- **Worker (disposable engine-graph process):**
  `app/sidecar/transcriptBackfillWorker.ts` — "One disposable engine-graph
  process … disappears when it exits" (`:1-10`); sets `CLAUDE_CODE_SIMPLE='1'`
  *before* any engine import (`:40`) to suppress SessionStart hooks. The catalog
  worker is the analogue: read stdin manifest (or take no manifest — the catalog
  is a global enumeration), call `loadAllProjectsMessageLogsProgressive` +
  `buildSessionsCatalogSnapshot` (reuse `sessionsCatalogDomain.ts:80-159`
  directly — it already builds the wire snapshot), emit the snapshot as bounded
  NDJSON, exit.
- **Boundary contract (shared, fail-closed):** `app/shared/transcriptBackfill.ts`
  — `parseTranscriptBackfillRequest/Result`, `MAX_*_BYTES`,
  `TRANSCRIPT_BACKFILL_BOUNDARY_VERSION`. The catalog worker needs its own
  parallel contract module of the same form (a `SessionsCatalogSnapshot` is
  already a protocol type, `shared/protocol.ts`), validated at the main-side
  parse boundary the way `parseTranscriptBackfillResult` is.
- **Trigger:** main already runs `backfillTranscriptCaches()` after first window
  paint, guarded by a `transcriptBackfillStarted` latch (`main.ts:253-256`). The
  catalog owner adds a `setInterval` (or self-rescheduling `setTimeout`) that
  invokes the catalog runner, guarded by a single-flight in-flight flag.
- **Delivery:** on an accepted snapshot, main emits it to the renderer over the
  existing host event stream (`sendHostEvent`, `main.ts:319`) as a read-only
  outbound catalog event; the renderer's existing catalog store consumes it
  (today fed by the sidecar `sessions.snapshot`; the store stays, the source
  changes).

What changes on the sidecar: once main owns the catalog, the per-sidecar refresh
timer (`sidecarServer.ts:443-451`) and `refreshSessionsCatalog` broadcast are
**removed** (or gated off), so no attached sidecar pays the ~230 MB **[RAM-0]**
plateau. That removal is the actual RAM win; the owner's per-run floor is the
cost booked against it.

---

## 6. Implementation sketch + acceptance criteria for (b)

**Sketch (smallest change that satisfies the task; a follow-up build session, not
this doc):**

1. `app/shared/sessionsCatalogWorker.ts` — boundary contract (result parser,
   size caps, boundary version), mirroring `shared/transcriptBackfill.ts`.
2. `app/sidecar/sessionsCatalogWorker.ts` — disposable worker entry: set
   `CLAUDE_CODE_SIMPLE='1'` first, enumerate via the existing
   `enumerateSessionsCatalog`/`buildSessionsCatalogSnapshot`
   (`sessionsCatalogDomain.ts:80-159`), emit one NDJSON snapshot record, exit.
3. `app/main/sessionsCatalogRunner.ts` — main-side runner in the
   `runTranscriptBackfill` shape (spawn one `--bare` worker, bounded NDJSON,
   fail-closed parse, `scanForSecrets`), plus a single-flight interval driver.
4. `app/main/main.ts` — start the interval after first paint; on an accepted
   snapshot, `sendHostEvent` a read-only catalog event to the renderer.
5. Sidecar: remove the per-sidecar refresh timer + broadcast
   (`sidecarServer.ts:443-451`, `:2310-2333`) and the domain's server-driven
   refresh, once the main owner is delivering; keep the pure builder
   (`buildSessionsCatalogSnapshot`) — it is now called from the worker.
6. Renderer: repoint the catalog store's source from the sidecar
   `sessions.snapshot` frame to the new host catalog event; no reducer/selector
   shape change.

**Acceptance criteria (a run is done only when all hold):**

- **Parity of the catalog contents:** the main-owned snapshot equals what a
  sidecar produced for the same corpus (same rows, titles, cwd reconciliation,
  `hasConversation`/sidechain drops) — a fixture test over
  `buildSessionsCatalogSnapshot` proves the builder is unchanged; a live-path
  test proves the worker delivers it end-to-end (not a shape-only test — the
  house defect is stub context).
- **RAM:** with N≥2 live sessions, no sidecar shows the catalog plateau; total
  app RSS drops by ≈(measured per-session plateau × N) − (owner per-run floor).
  Measured under the RAM-0 protocol, not asserted. **[RAM-0]**
- **Freshness:** a session created after the app launched appears within one
  interval + one worker run (same contract as today's 30 s refresh).
- **Zero-live-sessions:** the catalog still refreshes with no sidecars attached
  (the case (c) fails and (b) must pass) — a launch-with-all-closed test.
- **Failure isolation:** a worker crash/timeout keeps the last good snapshot
  (main-side degrade), never blanks the page; single-flight holds under a slow
  corpus (no overlapping spawns).
- **Security:** hardening smoke green; the new host catalog event is outbound
  read-only, `secretGuard`/`scanForSecrets`-clean; no new inbound frame kind.
- **Boundary tests** for the new NDJSON parser (accept valid, reject
  oversized/malformed/secret-bearing records), matching the PL-B boundary tests.

---

## 7. Interim knob available NOW (no new machinery)

Until (b) lands, two operator-gated, behavior-visible levers reduce the
per-sidecar cost with a one-line change each:

- **Lower `SESSIONS_CATALOG_ENRICH_LIMIT`** (`app/sidecar/sessionsCatalogDomain.ts:62`,
  currently `600`). SCRATCH: enrich=50 plateaued ~278 MB vs ~467 MB at enrich=600
  (RAM-1) — roughly the whole ~230 MB **[RAM-0]** plateau is the enrich work.
  **Trade-off (do not silently re-trade):** #16 *deliberately raised* this from
  50 → 600 because the low limit hid the operator's real terminal history behind
  the newest ~day of dev/test sessions (`sessionsCatalogDomain.ts:18-24,55-62`).
  Shrinking it re-introduces exactly that regression — it is a fidelity cut, not
  a free win, and needs operator acknowledgment.
- **Lengthen the 30 s refresh interval** (`SESSIONS_CATALOG_REFRESH_INTERVAL_MS`,
  `sidecarServer.ts:287`). Reduces enumeration *frequency* (CPU/IO), not the
  resident plateau; trade-off is a longer staleness window for newly-created
  sessions. This lever also survives into (b) as its cadence knob.

Neither interim knob changes ownership; both are stopgaps that (b) supersedes.

---

## 8. `[RAM-0]` numbers this doc still needs (fill from the RAM-0 artifact)

All figures below are currently **SCRATCH** (single-run, sandboxed, probe not
retained — audit F1/RAM-0). None is decision-grade until the RAM-0 measurement
session lands them with ≥3 repetitions, median/range, and counterbalanced order.
Do **not** fabricate; leave the `[RAM-0]` tag until measured.

1. **Per-session catalog plateau** — the resident memory a single attached
   sidecar spends on catalog enumeration at the shipping enrich limit. SCRATCH
   ~230 MB/session at enrich=600 (RAM-3.1). This is the *savings-per-avoided-copy*.
2. **Singleton worker resident floor** (shapes a/b/d) — RSS of one engine-graph
   catalog worker during a run. SCRATCH ~176–237 MB (RAM-1 bundling ladder:
   minified 176 / unbundled 237). For (b) this is only booked *during* a run.
3. **One-shot boot cost per run** (shape b) — wall-clock + CPU to spawn, import
   the engine graph, enumerate, and exit. SCRATCH ~0.3–1.8 s (RAM-3.1; includes
   the ~189 MB / ~311 ms engine-code import from PER-SESSION-COST.md §"Measured").
4. **Fleet delta** — total app RSS before/after (b) at N = 1, 2, 3, 5 live
   sessions: `savings ≈ N × (#1) − (#2 amortized) − delivery-seam overhead`.
   Requires #1 and #2 measured, plus the cohorts from RAM-2.
5. **Enrich-limit sensitivity** for the interim knob — plateau at enrich ∈
   {50, 200, 600} to price the fidelity/RAM trade of §7.

---

## 9. Locked-decision conformance (does not reopen anything)

This draft conforms to every locked decision and reopens none:

- **N-process** (one engine process per session) — untouched. (b) adds a
  *disposable* catalog worker that is NOT a session process (it holds no session,
  no socket, no turn), exactly as the PL-B backfill worker is not a session
  process (`transcriptBackfillWorker.ts:1-6`). The per-session process model is
  unchanged.
- **UDS transport** — untouched. The catalog moves to a main/host → renderer
  outbound event (host control plane), not a change to the sidecar↔supervisor
  Unix-domain socket.
- **Raw `AppSessionEvent` fidelity** — untouched. The catalog is a separate
  read-only snapshot, never an event mapper; no lossy mapping is introduced.
- **Die-with-window v1** — untouched. The catalog owner is main-supervised and
  dies with the app like every other main-owned worker.
- **Two-id model** (`appSessionId` ↔ `engineSessionId`) — untouched. The catalog
  keys on `engineSessionId` (the transcript key) exactly as today
  (`sessionsCatalogDomain.ts:180-193`).

Open tension to record (per audit RAM-3.1 and PER-SESSION-COST CC-4): moving
ownership out of the sidecar means the sidecar no longer self-refreshes the
catalog; that is a deliberate consequence of this decision, not a regression, and
this doc is the record of the choice.

---

## 10. Cross-references

- `docs/migration/reviews/2026-07-21-app-cutlist-ram-audit.md` — RAM-3.1 (this
  lever), RAM-0 (measurement protocol the `[RAM-0]` tags depend on), RAM-1/RAM-2
  (the SCRATCH figures), operator decision-queue item #4.
- `docs/migration/decisions/PER-SESSION-COST.md` — §"Reducible" item 1 first
  named "load the catalog once"; this doc supersedes that one-liner with the
  conforming owner analysis (host/main cannot import the engine graph).
- `docs/migration/decisions/SESSIONS-UNIFICATION.md` — the ratified requirement
  that the catalog enumerate the unified terminal∪app store; the owner shape must
  preserve unified enumeration.
- `docs/migration/decisions/REGISTRY.md` (D1) / `app/host/registry.ts:12-20` —
  the engine-free host-plane boundary that makes the naive move non-conforming.
- PL-B implementation (the reuse target): `app/main/transcriptBackfill.ts`,
  `app/sidecar/transcriptBackfillWorker.ts`, `app/shared/transcriptBackfill.ts`,
  trigger `app/main/main.ts:246-333`.
- `docs/migration/decisions/SECURITY-MINIMUM.md` — the outbound-secrets /
  read-only-snapshot posture the delivery seam must preserve (unchanged here).
