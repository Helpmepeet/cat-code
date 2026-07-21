# Desktop package audit: cut-list + RAM plan (2026-07-21, rev 4)

Read-only audit of `app/` (~80k lines) in two passes, run 2026-07-20/21 on the
`migration` branch with a clean `app/` working tree. No source was modified.
Pass 1: what to delete, deduplicate, and un-optimize. Pass 2: RAM reduction
within locked decisions (N-process stays; the lever space is per-process RSS
and how many processes are live).

**Revision 2** after the adversarial review
`2026-07-21-app-cutlist-ram-audit-review.md` (verdict RED). All nine findings
accepted in substance; per-finding disposition:

| Finding | Disposition in this revision |
|---|---|
| F1 measurements not reproducible | All RAM figures downgraded to SCRATCH (single-run, probe not retained); measurement-protocol session specified in §RAM-0 and made the first dispatch |
| F2 915 MB priced as marginal browse cost | Scenario table replaced with a cohort model; browse economics restated as bounds, not a price |
| F3 catalog move crosses engine-free boundary | Lever rewritten as an architecture decision across three conforming owners, each with its singleton cost |
| F4 renderer bound omits stores; clean close emits no terminal lifecycle | Lever rewritten around a cross-store `session-dispose` action; store inventory expanded; raw-log "ceiling" corrected; DOM claim narrowed |
| F5 park state-loss matrix wrong for effort/permissions | Matrix rebuilt field-by-field with persistence class per item |
| F6 bundle "zero blockers" over-claimed | Downgraded to a spike with an explicit proof list |
| F7 `messageCount` absent globally on the bounded path | Rider rewritten; "spawn-frozen" premise retracted (protocol doc drift, not runtime truth) |
| F8 safe total mixed gated/breaking work | Totals split into safe-now / operator-gated / breaking-v2; artifact accounting corrected (the `.js` is on-disk generated but untracked — an `rm`, not a tracked deletion) |
| F9 `selectSidebarRows` roster half is load-bearing | Deletion claim split: visual half deletable, roster half needs a named replacement selector; estimate revised |

**Revision 3** after the round-2 review (verdict RED on rev 2; five findings,
all verified against source and accepted):

| Round-2 finding | Disposition in this revision |
|---|---|
| R2-F1 `f2-attach-smoke` is contract-named, unique two-sidecar coverage | Moved OUT of safe-now: retain, or land equivalent automated coverage first (§I.3); safe-now total recomputed |
| R2-F2 park has no linearization vs a concurrent submit | Sidecar parking latch + ordered ack + retry/cancel semantics added as ratification-blocking design requirements (Part III) |
| R2-F3 effort survival misclassified | Matrix row split: xhigh/max/numeric die; low/medium/high persist as SHARED last-writer-wins (restore may adopt another session's value); pairwise test required (Part III) |
| R2-F4 clean close already reaches the renderer | Corrected: disposal drives off the existing `session-status (exited, restorable)` transition (`host.ts:473-482`); no new close signal (RAM-3.4) |
| R2-F5 measurement scheduled before the feature-set ruling | RAM-0 now pins feature configuration: current AND intended-shipping cohorts, counterbalanced order; feature ruling moved ahead of measurement in the queue |

**Revision 4** after the round-3 review
(`2026-07-21-app-cutlist-ram-audit-round3-review.md`, verdict RED on rev 3;
five findings, all verified and accepted):

| Round-3 finding | Disposition in this revision |
|---|---|
| R3-F1 `harness-demo` is contract-named P3-H integration coverage | Retracted from safe-now (same error class as R2-F1, different artifact); retained pending automated replacement; safe-now recomputed to ≈45 lines |
| R3-F2 "intended-shipping" cohort undefined before ruling #1 | Ruling #1 made a strict predecessor for shipping-target measurement; exploratory candidate manifests explicitly named and non-satisfying; manifest recorded in the raw artifact before sampling |
| R3-F3 thread goal dies on desktop resume | Matrix corrected: thread goal DIES (sidecar drops `ProcessedResume.initialState`, `sessionResume.ts:102-113`); other initialState riders (worktree, cost-state) downgraded to UNVERIFIED pending field-by-field check |
| R3-F4 effort partition incomplete | Re-partitioned by actual persistence condition: shared = low/medium/high + ant-conditional max; ephemeral = xhigh/ultra/numeric + external max; restore fallback stated (then-current shared value, else default resolution) |
| R3-F5 dispatch section contradicts the queue and the close-signal correction | Dispatch gates repaired: dwell on ruling #3, collapse on #8+#9, disposal wires existing events with no new signal |

Gate-check corrections (rev-4 gate review, 2 findings, both applied): queue
item #1 still carried the R3-F2 "alongside / both configurations" escape
hatch — removed, strict-predecessor wording now consistent everywhere; the
worktree/cost-state/context-collapse UNVERIFIED row misattributed them to the
thread-goal `initialState` drop — they restore via separate engine-side
resume side effects (`sessionRestore.ts:14,136-148,334-375`), and remain
UNVERIFIED only pending desktop public-path checks.

**Evidence classes used below** — `VERIFIED`: source-anchored, re-checkable by
grep/read. `SCRATCH`: single-run sandbox measurement, probe/raw output NOT
retained — directionally useful, not decision-grade (F1). `DESIGN`: unbuilt,
recon only.

Method: 9 subagents (5 cut-list, 4 RAM) + lead spot-checks; RAM measurements
ran sandboxed (scratchpad config home, network poisoned, no sessions created,
no accounts touched, live sidecar vmmap'd read-only, spawned processes killed).
Constraints honored: locked decisions not reopened; SECURITY-MINIMUM never
proposed for simplification; parity-ledger checked before calling UI code dead.
Line anchors are as of this audit; the tree is multi-writer — re-anchor before
executing.

---

## Part I — Cut-list

### Totals (F8 restatement; recomputed rev 4 per R3-F1)

- **Safe-now (no ruling, no behavior change): ≈ 45 tracked lines.**
  Micro-cuts only (§I.6 items a–e, g).
- **Retained pending replacement coverage (~682 tracked lines):** BOTH script
  harnesses — the `f2-attach-smoke` pair (~401, contract-named two-sidecar
  coverage, §I.3a) AND the `harness-demo` trio (~281, contract-named P3-H
  end-to-end proof, §I.3b). Each deletable only AFTER equivalent automated
  coverage of its path lands.
- **Operator-gated behavior change: ≈ 250–400 lines + ~717 wire-or-waive.**
  Dwell-spawn (§I.1, UX ruling), status-mapping collapse (§I.2, visible badge
  fixes + F9 scope revision), formatter consolidation (§I.6f, on-screen strings
  change), dark components (§I.5).
- **Breaking-v2 / design fork: ≈ 90–140 lines.** The `.result` ack fork
  (§I.4) — protocol-version treatment or failure-UI wiring, never a
  "mechanical" cut. Plus the `messageCount` seam (§I.7) — a product decision.

### I.1 Un-optimize: the 300 ms preview dwell-spawn (operator-gated)

- Anchor (VERIFIED): effect at `app/renderer/src/App.tsx:2602-2613` +
  `PREVIEW_DWELL_MS = 300` at `app/renderer/src/previewTranscriptState.ts:42`.
- Deliberate but NOT locked: M3 of
  `docs/migration/specs/2026-07-14-instant-session-open-design.md` (landed
  `f17853b`); the spec's header says "NOT a locked decision"; the dwell value
  is its open question Q2.
- Why it defeats the cache (VERIFIED, qualitative): no user acts within
  300 ms, so "spawn on engagement" degenerates into "spawn on every preview
  open"; a reader who only scrolls gets an engine process; CC-3 never reaps it
  (supervisor connection held for the session's life,
  `supervisor.ts:410`, TTL gate `sidecarServer.ts:466-479`).
- Replacement: delete effect + constant. Composer focus/pointer-down
  engagement is separately wired (`App.tsx:3142-3144`) and fires the identical
  path; cache-miss immediate spawn untouched; surrounding machinery serves any
  spawn-on-engagement design and stays.
- Breaks if wrong: zero tests assert the timer (SSR suite cannot see it). The
  regression is a "Connecting…" wait after first composer focus (~0.6 s
  measured cold-connect floor per the IS spec; 1–3 s perceived per
  PER-SESSION-COST — both prior figures, not re-measured here).
- **Cost honesty (F2):** the RAM benefit is real but its price is NOT
  established — see §RAM-2. What is established: today a browsed session costs
  one full engine process (≥ the ~237 MB SCRATCH boot floor, ≥ ~467 MB SCRATCH
  once attached with catalog refresh); after the cut a read-only browse costs
  ~0 marginal. The 915 MB figure is one long-lived churned PID, not the
  marginal browse price.
- Operator ruling needed: accept the connect wait for readers (P4-22's
  "restore immediately, no confirm" ratified removing a confirm dialog, not
  background spawns for readers).

### I.2 Collapse: the status mapping — FOUR copies, two live bugs (operator-gated; scope revised per F9)

- Anchors (VERIFIED): `deriveSidebarRowVisual`
  (`app/renderer/src/sidebarState.ts:218-243`); verbatim merged twin
  `deriveMergedRowVisual` (`sidebarState.ts:303-326`); `deriveTabVisualState`
  (`app/renderer/src/tabStatus.ts:66-95`); fourth copy `StatusBadge` at
  `app/renderer/src/SessionsPage.tsx:433-439`. The `sidebarState.ts:197-207`
  "mirrors the tab mapping" comment is false in 4/4 non-default arms.
- Live bugs in copy #4 (VERIFIED): `StatusBadge` checks `row.live` first
  (`MergedSessionRow.live`, `sessionsCatalogState.ts:209`) — a spawning row
  and a live socket-drop row both badge "live" while the TabBar shows
  `starting`/`disconnected`. Fixing them is a deliberate visible change —
  operator acknowledgment required.
- Replacement: one `sessionStatusVisual(status, restorable, inRegistry) →
  {label, tone}` module keyed off `SessionDescriptor['status']`
  (`app/shared/hostApi.ts:82`, produced by `host.ts:792-804` + crash-tombstone
  rule `host.ts:705-709`); `deriveTabVisualState` becomes a thin wrapper
  adding its connection-dead escalation.
- **F9 correction — `selectSidebarRows` is NOT delete-whole.** Its VISUAL half
  is near-dead (chips render only in `debugStateReport.ts:50`), but its ROSTER
  half is load-bearing: it is the descriptor source for
  `selectMergedSessionRows` (`App.tsx:818-830`), the workspace-trust join
  iterates it (`App.tsx:850-860`), and startup preload filters
  `row.visual.restorable` (`App.tsx:895-917`). The correct shape: delete
  `deriveSidebarRowVisual` + the `SidebarRow` visual type + the merged twin's
  duplicate switch; introduce a named `selectShellDescriptors(shell)` (or
  equivalent) carrying the ordering/hydration assumptions and their tests;
  preload filters `descriptor.restorable` directly
  (`visual.restorable === descriptor.restorable`, VERIFIED).
- KEEP TWO NAMED COMPARATORS (VERIFIED ruling): Sidebar = CC-2 warp-free
  message-send activity (`sidebarState.ts:353-368`); SessionsPage/Welcome =
  transcript mtime (`sidebarState.ts:370-372` documents the split). Do not
  unify orderings. Port-protect the CC-2 comparator tests
  (`sidebarState.test.ts:390-480`).
- Revised estimate: net ≈ −200 to −245 lines including tests (the surviving
  roster selector eats ~20–45 of the original estimate). Re-count from the
  tracked diff at implementation time.
- Breaks if wrong: sidebar click misrouting (restore at a live id / select on
  a dead row); tab restart affordance rides the same switch; the F13 hazard
  (live socket-drop mislabeled "crashed" + offered restore —
  `sidebarState.ts:228-233` exists to prevent exactly this).

### I.3 Stale phase-2/3 scripts — split disposition (revised per R2-F1)

- **(a) `f2-attach-smoke.ts` (356) + `run-f2-attach-smoke.ts` (45): RETAIN.**
  Rev-1/rev-2's "stale, superseded" claim is RETRACTED. The harness is named
  by decided/contract docs — `PROTOCOL-ENVELOPE.md` §8-A5 records that no
  two-sidecar process had ever run and directs Phase 3 to smoke exactly this
  path, and `backlog/phase3.md:175-180` says "Extend
  app/scripts/f2-attach-smoke.ts (extend, don't duplicate): TWO real sidecars
  under ONE supervisor" with named routing/crash-isolation/dead-session/
  ghost-replay assertions. It uniquely exercises two real sidecars + Electron
  attach/reload (`f2-attach-smoke.ts:282` region); the roundtrip/idleTtl
  probes are single-sidecar. It is still not wired into any automated gate —
  the improvement path is to convert its assertions into an automated
  two-sidecar probe test, and only THEN delete the manual harness. Until
  that lands, deletion is a test-confidence regression, not a cut.
- **(b) `harness-demo.ts` (154) + `harness-demo-driver.ts` (101) +
  `harnessDemoSource.test.ts` (26): RETAIN (revised per R3-F1).** Rev-3's
  "throwaway demo drivers, referenced by no contract doc" claim is RETRACTED
  — the same error class as the rev-2 `f2-attach-smoke` call, made against a
  different artifact. The decided P3-H design names the script as its FIFTH
  verification layer with executable end-to-end obligations
  (`specs/2026-07-05-gui-harness-design.md` §7.5: launch the dev renderer,
  real readiness/export predicates, drive renderer bridge → guard → IPC →
  picker bypass → cwd token → `validateCwd` → spawn, two same-cwd sessions
  with distinct PIDs); `backlog/phase3.md` P3-H implements that design, and
  STATUS's P3-H row lists "scripted demo" as a landed deliverable. The pure
  `devHarness.test.ts` unit layer does NOT cover this integration path — a
  change can leave it green while breaking the dev preload bundle, IPC
  registration, token chain, or Electron launch. Deletable only after an
  automated integration test proves the same production entry points.
  (`harnessDemoSource.test.ts` checks cleanup/source strings only; it is not
  that replacement.)

### I.4 The `.result` ack fork (breaking-v2 / design decision — NOT a mechanical cut)

- Anchors (VERIFIED, both directions): `agent-mode.set.result`
  (`sidecarServer.ts:1334` / `protocol.ts:994`), `task-control.result`
  (`:1396`/`:1055`), `run-control.result` (`:1491`/`:1134`),
  `settings.result` (`:1757`/`:1711`) — sent by the sidecar, zero renderer
  consumers (the apparent `SettingsResultFrame` hits are substring matches on
  the consumed `RemoteSettingsResultFrame`). State reaches the renderer via
  snapshot re-broadcast; the run-control requestId is minted, never awaited
  (`App.tsx:314`).
- These acks are the only wire signal for a FAILED verb (failure does not
  mutate the store → no re-broadcast); four sibling verbs DO consume theirs.
  Fork: wire all eight into failure UI, or remove four. Removal deletes
  ServerFrame union variants from a versioned wire contract — additive-only
  rule applies (`protocol.ts` header; CLAUDE.md §6) — so removal is a
  version-bump/tombstone decision, never bundled into a cuts session. ~90–140
  lines either way.

### I.5 Dark components: decide, don't delete (~717 lines, all parity-owed)

Zero truly dead renderer files. The 2026-07-13 trio partly self-resolved:
`SessionActionsMenu` and `MetadataInspector` are WIRED (`App.tsx:2128`,
`App.tsx:2179` — VERIFIED reachable via TabBar ⋯ / Sidebar / SessionsPage).

| Component | Lines | State (VERIFIED) | Recommendation |
|---|---|---|---|
| `ConnectionChip.tsx` | 144 | Dark; substitute `ConnectionRecovery` inline row ships the UX; ledger row 2016 falsely claims it live | Delete with explicit waive — strongest candidate |
| `PermissionRulesEditor.tsx` | 126 | Detached by P4-24 reskin `f213c8c`; ledger rows 538/561-608/2115-2116 + STATUS.md:286 stale-claim mounted | Wire-or-waive (P2-4 C3 read-only rules view; embed deferred, ledger 787) |
| `BannerStack.tsx` | 222 | Built-ahead P4-1 primitive; mount deferred to P4-15 (ledger 144); rows 134/437/847/1879 stale-claim mounts | Keep — named owner |
| `ToolInspector.tsx` | 225 | Ledger row 360 itself flags "ADAPTED but UNWIRED" | Wire-or-waive under P4-18b |

Two-strikes rule: this audit is the SECOND review flagging
`PermissionRulesEditor` and `ToolInspector` unwired (first: 2026-07-13
ui-drift §C) — named owner or recorded waive now required.

### I.6 Micro-cuts

Safe-now (~45 lines):
- (a) `SessionRegistry.touchAttached()` — no production caller
  (`registry.ts:691-700` + 3 test cases). ~13 lines.
- (b) `mintAppSessionId()` + sole-user import (`registry.ts:1037-1039`;
  host mints its own, `host.ts:244`). ~5 lines.
- (c) Supervisor write-only `SidecarRecord.restartCount`
  (`supervisor.ts:82,242,333,341`). ~4 lines.
- (d) Dead tone tokens `--tone-default`/`--tone-accent`
  (`theme.css:14-15,63-64`; `tone.ts:44-62` maps those tones elsewhere).
  4 lines.
- (e) `DROPPED_PROTOTYPE_AGENT_IDENTITY_FIELDS` tautological test
  (`agentIdentity.ts:237-244` + `agentIdentity.test.ts:360-368`) — demote the
  parity note to a comment. ~16 lines.
- (g) `newRequestId` triplicated one-liner (`App.tsx:316`,
  `AccountsPage.tsx:70`, `RemoteSettingsPage.tsx:27`) → inline
  `crypto.randomUUID()`. ~3 lines.

Operator-gated:
- (f) Token/duration formatters ×3/×2 (`App.tsx:3292`,
  `ComposerActionsBar.tsx:559`, `MetadataInspector.tsx:299/303`, inline
  `TranscriptView.tsx:1306`) → one `format.ts`. ~13 net lines. The three token
  impls produce DIFFERENT on-screen strings for the same input and each cites
  a prototype anchor — canonical output is a parity-visible choice.

### I.7 `messageCount` (rewritten per F7 — product decision, not a type fix)

Retraction: rev 1 called the catalog "spawn-frozen" with fresh sessions
uniquely defaulting to 0. Current runtime truth (VERIFIED):
- the sidecar refreshes the catalog every 30 s while attached
  (`sidecarServer.ts:443-451`);
- the bounded loader NEVER populates `messageCount` — its own header says the
  field "needs a full-chain read" and is "NOT populated by this loader"
  (`sessionsCatalogDomain.ts:8-16`), and the mapping passes the lite loader's
  absence through as 0 (`sessionsCatalogDomain.ts:~186`,
  `sessionsCatalogState.ts:217`);
- so "Most active" (`sessionsCatalogState.ts:318`) degrades to mtime for
  every bounded-catalog row, and the "N msgs" chip is hidden by the `> 0`
  guard (`SessionsPage.tsx:398`) for all of them.
- The "spawn-frozen" wording at `protocol.ts:1883-1884,1924-1928` is doc
  drift; correct it in the same session.

Fix fork (operator): fund a bounded real-count seam (engine-side, without
full-chain reads per row), or remove the "Most active" sort + message chip.
`number | null` alone changes nothing user-visible — every bounded row becomes
null and the sort still degrades.

### Cleared as NOT bloat (checked; do not chase)

host vs supervisor state (different by design; `host.ts:512` composes);
sidecar domains (each adds redaction/validation/projection; the real-vs-fake
executor seam is the headless-test security boundary); `transcriptBackfill`
trio (one pipeline, three roles); `App.tsx` (all 20 reducers dispatched via
`applyServerFrameBatch`, `App.tsx:606-627`); all four suspect deps used
(`TranscriptView.tsx:31-34,1473`); looks-dead-but-load-bearing:
`sdkMessageFixtures.ts` (exhaustiveness tripwire),
`sidecar/engineTypeDriftCheck.ts` (compile-time snapshot guard),
`main/devHarness.ts` (live P3-H), `shared/jsonSafe.ts`.

---

## Part II — RAM

### RAM-0 (F1): measurement protocol owed BEFORE any ruling relies on numbers

Every figure below is **SCRATCH**: single-run, sandboxed, probe scripts and
raw `ps`/`vmmap` output not retained; corpus was synthetic (real-shaped: 60
dirs / ~1,800 files / ~1 GB) but its generator was not kept; no repetitions,
no variance, no machine-pressure record. `Bun.gc(true)` returning 0 does not
by itself establish retained private-dirty memory. The predecessor
PER-SESSION-COST probe was likewise an uncommitted scratch script (its
§60-63).

First dispatch of any RAM work is therefore a **measurement session**: check
in a hermetic probe (no secrets) + corpus recipe + dated raw-results artifact;
report RSS AND footprint/private-dirty; ≥3 repetitions with median/range;
counterbalanced A/B run order (not one fixed order); cohorts per RAM-2. Until
it lands, every delta here is UNVERIFIED.

**Feature configuration (R2-F5, tightened per R3-F2).** Today's sidecar runs
with every `feature()` gate OFF (Part IV drift note). An "intended-shipping"
cohort DOES NOT EXIST until ruling #1 defines its exact manifest — deciding
that manifest IS the ruling. Therefore: ruling #1 is a strict predecessor for
any shipping-target measurement, and the exact sorted feature manifest (plus
build/probe method) must be recorded in the raw-results artifact BEFORE the
first sample. Pre-ruling exploration may measure explicitly NAMED candidate
manifests, but those runs are exploratory and do not satisfy RAM-0.
"Alongside" the ruling is acceptable only if the manifest is finalized and
recorded before sampling begins. The current-featureless configuration can
always be measured and labeled as such.

### RAM-1: what the scratch runs suggest (decomposition)

- Boot floor ~237 MB (bare bun 20 + module graph ~195 + init/controller ~20);
  probe-mode listening-idle 218.
- Attached-idle plateau ~467 MB after ~8 catalog-refresh cycles at enrich=600
  (the sidecar re-enumerates the catalog every 30 s while attached —
  `sidecarServer.ts:443-451` VERIFIED; the plateau figure is SCRATCH).
  Enrich=50 plateaued ~278.
- One long-lived production PID vmmap'd read-only: 915 RSS / 833 footprint;
  ~700 MB Bun-native mimalloc resident+dirty (region identified as mimalloc
  via `MIMALLOC_OS_TAG` relabel — SCRATCH, single observation); JSC heapSize
  34–36 MB in every config (JS objects are a rounding error); ~180 MB dylib
  `__TEXT` shared/clean (not a cost). Growth driver of the native pool
  UNATTRIBUTED (needs instrumented live turns).
- Bundling ladder: unbundled 237 → minified single-file bundle 176; bytecode
  CJS 232 (+ the 95 MB `.jsc` resident); compiled binary 251. `--smol`: 0–5 MB
  effect everywhere. Periodic `Bun.gc(true)`: no RSS effect.

### RAM-2 (F2): cohort model — what a session actually costs

The marginal cost of a browsed session is NOT established. 915 MB is one
churned long-lived PID; a dwell-spawned reader starts a FRESH process and does
not inherit that allocator history. Known anchors (SCRATCH): fresh spawn ≥
boot floor ~237; attached long enough for catalog refreshes → ~467 plateau;
long-lived churned → 915 observed once. Resumed-large-transcript weight:
unmeasured. The measurement session must produce distributions for five
cohorts: (1) cache-hit preview, no engagement (should be ~0 engine MB after
the dwell cut); (2) freshly dwell-spawned attached-idle; (3) one completed
turn; (4) restored large transcript; (5) long-lived multi-turn — plus
total-app memory, not just sidecar RSS.

The rev-1 "6.5 GB → ~1 GB" scenario table is WITHDRAWN (it priced every
session at the churned-PID number and asserted an unmeasured "after" of
400–500 MB). The defensible qualitative claim: today, browsing N sessions
costs N engine processes that never idle-reap; after the dwell cut it costs
zero engine processes for pure readers.

### RAM-3: ranked levers (rev 2)

1. **Per-sidecar catalog enumeration (F3: architecture decision FIRST).**
   The cost is real (VERIFIED mechanism: every attached sidecar re-enumerates
   every 30 s, `sidecarServer.ts:443-451` +
   `loadAllProjectsMessageLogsProgressive`, `sessionsCatalogDomain.ts:41-45`;
   plateau size SCRATCH ~230 MB/session at enrich=600). But "move to
   host/main" as rev 1 said is NON-CONFORMING: the host plane must not import
   the engine graph (`registry.ts:12-20` VERIFIED), Electron main stays
   engine-free by design (the PL-B backfill worker exists precisely for this,
   `main.ts:246-251` VERIFIED), and the catalog domain's own header says the
   host cannot enumerate transcripts (`sessionsCatalogDomain.ts:1-8`).
   Conforming owner shapes, each with a singleton cost that must enter the
   savings table:
   - (a) main-supervised persistent Bun catalog worker (transcriptBackfill
     pattern): own ~176–237 MB floor, always resident;
   - (b) main-supervised one-shot worker on a timer: repeated boot cost
     (~0.3–1.8 s SCRATCH), near-zero resident between runs;
   - (c) designated-sidecar publisher: no new process, but
     ownership/failover + a zero-live-sessions policy;
   - (d) extracted engine-free scanner (re-implement the lite scan like the
     registry re-implements path encoding): smallest resident cost, largest
     drift risk against `sessionStorage.ts`.
   Decision inputs: N=1 vs N>1 economics differ per shape; cache freshness;
   failure modes; security (the worker reads transcripts — outbound secrets
   posture unchanged, engine-side only). **Interim knob available now**
   (operator-gated, behavior-visible): lower
   `SESSIONS_CATALOG_ENRICH_LIMIT` (`sessionsCatalogDomain.ts:66`) — note
   #16 deliberately RAISED it from 50 because the low limit hid real history;
   shrinking it re-trades that. Or lengthen the 30 s interval.
2. **Dwell-spawn removal** — §I.1. Fleet-level: readers stop costing a
   process at all. Price honesty per RAM-2.
3. **Idle-park + live-session cap** — Part III. Bounds live-process count;
   frees a full process per parked session (whatever its cohort cost is).
4. **Renderer session-dispose (F4 rewrite).** The unbounded renderer growth
   is real, but the rev-1 fix (prune two maps) does NOT bound the renderer,
   and the close path makes per-store pruning insufficient by construction:
   - Signal correction (R2-F4): what is missing is DISPOSAL WIRING, not a
     signal. Clean close emits no terminal SIDECAR-plane lifecycle frame
     (`main.ts:580-588`; supervisor emits no exit after a host-asked kill,
     `supervisor.ts:317-325`, `host.ts:112-120`), but the HOST plane already
     tells the renderer: `Host.closeSession` emits a `session-status` event
     carrying the new `(exited, restorable)` descriptor
     (`host.ts:473-482` VERIFIED), and the renderer subscribes to that stream
     (`App.tsx:653`). Today that transition updates only shell/preview state
     (`App.tsx:678-688`); no frame-keyed store listens.
   - Session-keyed stores that retain their last value after ordinary close
     (inventory, to be completed at implementation): live transcript
     (`transcriptProjector.ts:238,243,249` — rows, `seenFrameIds`, FULL tool
     results; append-only, `:1292-1304`; no `session-removed` case), raw
     message log (`rawMessageLog.ts` — 8 MiB cap PER RETAINED SESSION,
     unbounded session count; rev-1's "~80 MB ceiling" was wrong), plus the
     frame-keyed snapshot stores (catalog, extensions, accounts, settings,
     agent config, goals/memory, diagnostics, slash catalog, permissions,
     tasks) and renderer-local `promptDrafts`/paste/history state
     (`App.tsx:347-353`; a pending paste holds the full unbounded string,
     `composerState.ts:91-98,145-161`).
   - DOM correction: at most three workspace panels mount
     (`workspaceLayout.ts:3-4`), so DOM does not double ALL retained data —
     only mounted panes lack virtualization.
   Fix shape: ONE `session-dispose` action driven by the EXISTING host
   transitions — the live→`(exited, restorable)` `session-status` event and
   `session-removed` — folded through every per-session reducer + local
   store; a future `parked` descriptor flag distinguishes park (retain) from
   close (dispose). Do NOT invent a second close signal (R2-F4). Separately
   decide what survives PARK (tab kept) vs CLOSE/REMOVE; per-session
   row/byte caps on the live transcript with a truncation-boundary row. Acceptance evidence: heap snapshots before/after repeated
   open/close, not suite-green. Expected size: material but UNQUANTIFIED
   until measured (rev-1's −150–500 MB had no heap snapshot behind it).
5. **Sidecar bundle (F6: downgraded to SPIKE).** SCRATCH ladder suggests
   −61 MB at idle (237→176) and the build itself succeeded (5,369 modules,
   0.4 s, no build-time blockers). NOT established: a bundled sidecar
   surviving ready→submit→permission→result on a live turn; real restore;
   the transcriptBackfill worker entry; native/vendored paths; hardening
   suite; feature matrix (see drift note, Part IV); orphan identity — main
   currently uses the TS entry PATH as the orphan marker
   (`main.ts:364-382`, `registry.ts:499-501`, `reap-orphan-sidecars.ts:35`).
   Spike exit criteria = all of the above proven, plus re-measured deltas
   under RAM-0 protocol. Skip bytecode/`--compile` for RAM (memory-negative,
   SCRATCH) — boot-latency lever only.
6. **`MIMALLOC_PURGE_DELAY=0` spawn env** — one line in `sidecarEnv`
   (`supervisor.ts:218-230`); mimalloc reads `MIMALLOC_*` env (SCRATCH
   observation). Entirely UNMEASURED effect; cheap A/B inside the
   measurement session. Potentially the largest per-process lever if the
   native pool is purge-delayed high-water; possibly zero.

Dead ends (SCRATCH, consistent across configs): `--smol`, periodic
`Bun.gc(true)`, bytecode/compile for memory purposes.

---

## Part III — Idle-park design summary (lever 3; DESIGN)

Parking = host-initiated kill of idle engines behind kept tabs; restore via
machinery that already exists (`host.restoreSession` `host.ts:255-328`
preserves both ids; engine resume is the TUI `--resume` flow,
`conversationRecovery.ts:469`, `sessionRestore.ts:644`; renderer restore UX =
the P4-28 path with replay coalescing armed at `main.ts:1004`).

Key verified facts: CC-3's TTL fires only at zero supervisor connections and
the supervisor holds its socket for the session's life — NO live desktop
session ever idle-TTLs today; CC-3 is the orphan janitor. The renderer holds
no sockets, so "disconnect but keep tab" needs no transport change; the real
blockers are `foldTabMembership` revoking tabs on clean close
(`shellState.ts:141-161`) and `connectionState` disabling the composer
(`connectionState.ts:54-87`). Cheapest status shape: additive
`parked: boolean` on `SessionDescriptor` (the `lastMessageSentAt` precedent,
`hostApi.ts:87-95`); parked rows must be EXCLUDED from `enforceBound`'s
32-row terminal reap (`registry.ts:58,509-552`) or their tabs dangle.

Plumbing: one new inbound `app.park` frame with full SECURITY-MINIMUM tax
(sidecar-local schema, allowlist entry, boundary tests, decision doc-comment);
sidecar handler = safety-gate check → typed refusal or ack-then-graceful-exit
(`index.ts:315-322`); host `parkSession` + `parking` suppression (the
`closing` precedent, `host.ts:461-471`) + `evictReplay` + `registry.markParked`
+ `emitStatus`; LRU/cap policy in host; one HC3 preload sender + hardening
inventory entries; renderer keeps tab when parked, pane routes to the preview
path, unpark = existing `performRestore`/engage. No new visual chrome without
operator sign-off.

Safety gates (validated IN the sidecar — engine truth): no active turn
(`sidecarServer.ts:331`), no pending permission request
(`AppSessionController.ts:78-80`; T5a forbids resurrecting request ids), no
running background/agent-mode tasks (note: `sidecarServer.ts:542-547` only
shows WHERE task state lives — it builds attach snapshots; a real gate over
that state must be defined, it does not exist yet). Park is automatic and may
NEVER lose a turn (stricter than D6's quit waiver).

**Linearization requirement (R2-F2 — ratification-blocking).** Check→ack→exit
is NOT sufficient: submit handling checks-then-sets `activeTurn` inside the
submit path (`sidecarServer.ts:1039-1051`), so a submit arriving between the
park gate check and process exit is ACCEPTED and then killed — exactly the
turn loss the design forbids. The host-side `parking` suppression only fixes
exit CLASSIFICATION; it cannot close this input race. Required design, in the
sidecar: a parking LATCH set atomically with the gate check — once latched,
`app.submit` (and other turn-starting verbs) receive a typed rejection (e.g.
`session_parking`) instead of starting a turn; re-verify gates AFTER latching
(a turn accepted before the latch aborts the park, not the turn); the park
ack is the last outbound frame. Renderer semantics for the rejection —
retry/queue/auto-unpark — need their own correlation design (rev-2's
"submit-after-park auto-unparks" was an unspecified aspiration, not a
mechanism) and boundary tests for latch-then-submit and submit-then-latch
orderings.

### State across park/restore (F5 rebuild — by persistence class)

| Item | Class | Evidence |
|---|---|---|
| Conversation + turn context | SURVIVES (engine JSONL, incremental append) | `sessionStorage.ts:2964`; resume seeds engine + replay (`sessionController.ts:301-309`, `sidecarServer.ts:629-685`) |
| Both ids, cwd, title | SURVIVES (registry-backed) | `host.ts:322-327`; title durable via `registry.setTitle` (`host.ts:499-506`) |
| **Thread goal** | **DIES on the current desktop path — rev-3 was wrong.** The engine loader recovers it into `ProcessedResume.initialState` (`sessionRestore.ts:805-821`), but the sidecar DROPS that state: `resumeEngineSession` returns only `{engineSessionId, messages}` (`sessionResume.ts:102-113`), the controller builds a fresh store from `getDefaultAppState()` (`sessionController.ts:191-207`, default `threadGoal: null`), and the renderer submit path sends no `goalSnapshot` to repair it (`App.tsx:1417-1441`). Fundable: thread the processed initial state (or a narrower goal restoration) into the sidecar's store; acceptance = a public spawn→goal→park→restore assertion | R3-F3 |
| Worktree, cost-state, context-collapse | UNVERIFIED — but NOT via the thread-goal drop (rev-4's first attribution was wrong): these restore through SEPARATE engine-side side effects during resume (`restoreCostStateForSession`, `sessionRestore.ts:14`; context-collapse persist replay `:136-148`; worktree chdir/restore `:334-375`), which do execute in the sidecar's `processResumedConversation` call. Whether their EFFECTIVE desktop behavior is correct needs field-by-field public-path verification before listing any as surviving | rev-4 gate review F2 |
| Composer draft | SURVIVES park (renderer-local, keyed by appSessionId) | `App.tsx:3482-3499`; dies only on app quit |
| **Effort — persistable-shared: low/medium/high, plus `max` when `USER_TYPE=ant`** | SHARED-SURVIVES (last-writer-wins): persists to `userSettings`, but restore reloads the CURRENT shared value, not the parked session's — session A (high) parked, session B sets low, A restores as low | `src/utils/effort.ts:121-136` (`toPersistableEffort`); `effort.tsx:16-27`; `sessionController.ts:195-207` |
| **Effort — ephemeral: xhigh/ultra/numeric, plus `max` for external users** | DIE as overrides — and restore is NOT a clean reset: a non-persistable selection performs no settings write (`effort.tsx:16-27`), so restore reveals the THEN-CURRENT persisted shared value if one exists (possibly older, possibly another session's), else model/default resolution. `ultra` is a live desktop case (offered for gpt-5.6-sol/terra, `runControlsDomain.ts:300-306`); numeric is engine-reachable but not offered by the desktop picker | `effort.ts:13-20,121-136`; `runControlsDomain.test.ts:158-166` (R3-F4) |
| **Always-allow permission selections (userSettings/project destinations)** | **SURVIVE — rev-1 conflated classes.** Engine applies + persists re-attached engine-authored updates via its normal decision path | `sidecarServer.ts:1815-1832`; `PermissionPromptToolResultSchema.ts:95-106` |
| Session-DESTINATION permission updates; permission MODE | DIE (session-scoped by construction) | `sidecarServer.ts:1094-1101` |
| Model override, fast mode | DIE (in-memory in the desktop path) | `runControlsDomain.ts:86-92` |
| Agent-mode restoration fidelity | DEGRADES (headless resume passes `modeApi: null`) | `sessionResume.ts:88-99` |
| In-flight turn | GATED AWAY (park refuses) | §Safety gates |
| Pending permission requests | DIE, unrecoverable BY DESIGN | `transcriptCache.ts:13-18`; T5a |
| Scroll position | DIES (preview→live swap resets rows) | `App.tsx:602-605`; `previewTranscriptState.ts:52` |
| MCP connections | MOOT today (`mcpClients: []`) | `sessionController.ts:232-233` |

Before ratification: prove park→restore through the real public path
(spawn → turn → park → restore → verify effort/permission/mode behavior), per
field — not from this table alone. The effort rows specifically need a
TWO-SESSION pairwise test that also covers the ephemeral fallback: seed a
persisted value, select an ephemeral value (`xhigh`/`ultra`) in session A,
mutate or preserve the shared value from session B, restore A — asserting A
lands on B's value (or the seeded one), never on A's ephemeral selection.
Include a Sol-at-`ultra` case.

Rulings: conforms to N-process/UDS/raw-events/die-with-window/two-id and is
CC-4's own recommendation (`PER-SESSION-COST.md:119-121`). One tension: CC-4's
"CC-3 already does the reaping" is false for attached sessions; host-initiated
park leaves CC-3 untouched, sidecar SELF-parking would amend it — record the
choice in a new decision doc. Riskiest failure modes: the submit/permission
race (now a specified latch requirement, see above — the highest-severity
open design item); silent state reset behind an open tab (the DIE rows
above — operator must accept or fund persistence); registry bookkeeping races
(parked-exit misread as crash; parked row evicted at the 32-row bound) — the
same seam as P4-28's open findings.

---

## Part IV — Drift and bookkeeping surfaced

- **Feature-gate drift (VERIFIED, confirmed independently by the review):**
  under plain `bun run`, `bun:bundle` `feature()` gates evaluate OFF in the
  sidecar — the desktop runs a featureless engine while `cli-dev` bakes in
  ~40 dev-full features. Needs an operator ruling regardless of bundling.
- **PARITY-LEDGER mount drift, both directions:** rows
  134/437/538/847/879/1879/2016/2115-2116 assert mounts that no longer exist
  (mostly P4-24 `f213c8c` casualties); rows 207/1207/1223/1275-1342 still
  call the now-wired `SessionActionsMenu`/`MetadataInspector` "deferred";
  STATUS.md:286 claims `PermissionRulesEditor` wired (it is unmounted).
- **Protocol doc drift:** "spawn-frozen" catalog comments at
  `protocol.ts:1883-1884,1924-1928` vs the live 30 s refresh (§I.7).
- **STATUS gap:** IS-A/B/C + PL-A/PL-B have no STATUS rows (specs + commits
  `f17853b`, `3481a98` only).
- **Two-strikes obligations:** `PermissionRulesEditor`, `ToolInspector`
  (second flag each) need a named owner or recorded waive.

## Part V — Open uncertainties

All RAM deltas (SCRATCH, RAM-0); marginal browse-session cost (RAM-2
cohorts); native-pool growth driver; `MIMALLOC_PURGE_DELAY` effect; bundled
sidecar under real load (spike, RAM-3.5); catalog singleton owner + its
economics (RAM-3.1); renderer store inventory completeness + heap-snapshot
sizes (RAM-3.4); park design's renderer death-path clearing, abandoned-lock
staleness sizing, `inputEnabled` update sources, and the
effective desktop behavior of the resume side effects (worktree, cost-state,
context-collapse — separate mechanisms from the thread-goal `initialState`
drop; rev-4 gate review F2); `messageCount` seam cost
(§I.7); `.result` fork direction (§I.4).

## Operator decision queue (blocking)

1. Feature set for the sidecar (today: all gates OFF — drift, Part IV).
   STRICT PREDECESSOR for shipping-target measurement (R3-F2): the exact
   sorted manifest must be ruled and recorded in the raw-results artifact
   before the first shipping-target sample. Pre-ruling runs may measure only
   the current-featureless config and explicitly NAMED candidate manifests,
   labeled exploratory and non-satisfying for RAM-0.
2. Fund the RAM-0 measurement session (prerequisite for pricing anything).
3. Dwell-spawn: accept reader connect-wait for zero reader spawns (§I.1).
4. Catalog owner: pick shape a/b/c/d (RAM-3.1) — architecture decision doc.
5. `.result` fork: wire all eight or version-bump-remove four (§I.4).
6. Dark components: waive-or-own `ConnectionChip`, `PermissionRulesEditor`,
   `ToolInspector` (two-strikes binding).
7. Idle-park: ratify host-initiated shape + the DIE rows of the F5 matrix +
   the parking-latch linearization design (R2-F2); new decision record
   (Part III).
8. StatusBadge fixes in the §I.2 collapse are deliberate visible changes —
   acknowledge.
9. `messageCount`: fund a count seam or remove the sort/chip (§I.7).
10. Script harnesses: fund automated replacements — a two-sidecar probe for
    `f2-attach-smoke` (§I.3a) and an integration test of the P3-H
    launch/bridge/spawn path for `harness-demo` (§I.3b) — or keep both as-is.
    Deletion without a replacement is off the table for either.

## Suggested dispatch shape (rev 4)

1. Measurement session (RAM-0), strictly after the feature-set ruling (#1)
   with the exact manifest recorded before sampling — pre-ruling runs may
   measure only the current-featureless config and explicitly NAMED candidate
   manifests, labeled exploratory: hermetic probe + corpus + cohorts + raw
   artifact; includes the MIMALLOC A/B. Everything quantitative depends on it.
2. Small safe-cuts session: §I.6 safe micro-cuts only (~45 lines; BOTH script
   harnesses retained per §I.3).
3. Small operator-gated session (after ruling #3): dwell-spawn delete;
   optionally the catalog interim knob (after its trade is acknowledged).
4. Medium session (after rulings #8 AND #9): §I.2 status collapse with the
   F9 split (`selectShellDescriptors`) + §I.7 per the chosen direction.
5. Medium session: renderer `session-dispose` (RAM-3.4) — wire ONE disposal
   action from the EXISTING `session-status (exited, restorable)` and
   `session-removed` host events through every per-session store; no new
   close signal; heap-snapshot acceptance.
6. Architecture decision doc, then implementation: catalog owner (RAM-3.1).
7. Spike: bundled sidecar proof list (RAM-3.5).
8. Multi-session program, decision record first: idle-park + cap (Part III).
9. Docs pass: ledger/STATUS/protocol-comment corrections (Part IV).
