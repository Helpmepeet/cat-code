# Adversarial review — desktop cut-list + RAM audit (2026-07-21)

**Reviewed artifact:**
`docs/migration/reviews/2026-07-21-app-cutlist-ram-audit.md`

**Verdict: RED — rework before using the audit as a dispatch or investment
plan.**

The cut-list contains useful source recon: the preview dwell timer, duplicated
status presentation, stale scripts, unused result frames, dark components, and
per-sidecar catalog enumeration are all real leads. The failure is in promotion:
scratch measurements and partially specified designs are presented as precise
per-session economics and dispatch-ready levers. Three load-bearing conclusions
do not survive cold review: 915 MB is not established as the marginal cost of a
freshly browsed session, the highest-ranked catalog move has no conforming
engine-free owner, and the proposed renderer cleanup does not actually hard-bound
renderer lifetime memory.

## Findings

| ID | Severity | Finding | Disposition |
|---|---|---|---|
| F1 | High | Load-bearing RAM measurements are not reproducible. | React now: retain a runnable probe, corpus recipe, raw outputs, sampling protocol, and repetitions before product rulings. |
| F2 | High | One churned 915 MB sidecar is incorrectly priced as the marginal cost of every freshly browsed session. | React now: remeasure fresh preview-only, attached-idle, one-turn, resumed-large, and long-lived cohorts. |
| F3 | High | “Move catalog enumeration to host/main once” has no conforming engine-free implementation or honest singleton cost. | React now: architecture decision first; measure the chosen global owner in total-app memory. |
| F4 | High | The renderer “hard bound” omits most lifetime-keyed stores and clean-close performs no cross-store disposal. | React now: one shared session-disposal action across every keyed reducer/local store, with heap evidence. |
| F5 | Medium | Idle-park's state-loss inventory is false for effort and conflates durable permission rules with session-only grants/mode. | Correct the decision matrix and prove park→restore through public paths before ratification. |
| F6 | Medium | The bundle lever is labeled “zero blockers” while its live, feature, packaging, and identity paths are unverified. | Downgrade to experiment; require a bundled live-turn/restore/security/worker proof. |
| F7 | Medium | The `messageCount` rider diagnoses stale/fresh rows, but the bounded loader populates no real message counts at all. | Either add a real count seam or remove the “Most active” sort/chip; nullable shape alone cannot fix it. |
| F8 | Medium | The “mechanically cuttable now” total includes a breaking, operator-gated protocol fork. | Split totals into safe-now, operator-gated, and breaking-v2 buckets; recompute actual tracked deletions. |
| F9 | Low | The registry-only sidebar pipeline is not consumed only for `restorable`; the deletion scope omits live descriptor consumers. | Name the replacement descriptor selector and re-estimate the collapse rather than dispatching “delete + re-point debug.” |

### F1 — The RAM evidence cannot be rerun

The audit gives a narrative of scratch probes and sandboxing
(`2026-07-21-app-cutlist-ram-audit.md:10-17`) plus a final table (`:303-319`),
but no retained probe, exact commands, settle rule, number of repetitions,
variance, corpus generator/manifest, raw `ps`/`vmmap` output, or machine-pressure
state. Repository search finds the `MIMALLOC_OS_TAG`, 5,369-module, and plateau
figures only in the audit itself. The predecessor cost note likewise says its
probe was an uncommitted scratch script
(`decisions/PER-SESSION-COST.md:60-63`).

Failure scenario: the operator funds plumbing on the strength of “−230 MB” and
“−61 MB,” but neither delta can be distinguished from corpus shape, allocator
high-water, run order, or one-off process history. `Bun.gc(true)` not reducing RSS
does not establish retained private dirty memory, and a single settled sample
does not establish a distribution.

**Owner/disposition:** a performance-measurement session must check in a
non-secret hermetic probe and a dated raw-results artifact. Report RSS,
footprint/private-dirty, repetitions, median/range, run order, and corpus shape.
Until then all quantitative RAM deltas are **UNVERIFIED**.

### F2 — The headline browse economics extrapolate the wrong cohort

The audit separately reports a fresh attached-idle plateau of about 467 MB
(`audit:227-232,317-319`) and says the remaining native-pool growth needs live
turns to attribute (`:233-236`). It nevertheless prices each reader at roughly
915 MB (`:256-257`) and multiplies seven such processes into 6.5 GB
(`:321-330`). A dwell-spawned reader starts a new sidecar; it does not inherit the
allocator history of the one long-lived production PID that was `vmmap`'d. The
audit also lists resumed-transcript memory as unmeasured (`:453-454`), so that
unknown cannot bridge 467→915.

The “after” estimate is unsupported too: 915 − 230 catalog − 61 bundle is about
624 MB, not the table's 400–500 MB, and lever 6 is explicitly unmeasured. The
statement “floor 176 + turn-time growth” (`:330`) supplies no measurement that
bounds growth to 224–324 MB.

Failure scenario: dwell removal is approved with an advertised ~885 MB/browse
and ~5.5 GB scenario saving that the evidence does not show. The product choice
may still be correct, but the price is not.

**Owner/disposition:** measure separate cohorts: fresh cache-hit preview with no
engagement, freshly dwell-spawned attached-idle, one completed turn, restored
large transcript, and long-lived multi-turn. Use distributions and total-app
memory, not one old PID.

### F3 — The top catalog lever crosses the engine-free boundary without an owner

The recommendation says to move enumeration “to host/main once”
(`audit:251-255`) and dispatches “host-level catalog enumeration” (`:483-485`).
But the current domain imports the engine's `sessionStorage` loader
(`app/sidecar/sessionsCatalogDomain.ts:41-45`) precisely because the host cannot
enumerate transcripts (`:1-8`). The host registry contract forbids importing the
engine graph (`app/host/registry.ts:12-20`). Existing transcript-cache backfill
uses a separate worker so Electron main stays engine-free
(`app/main/main.ts:246-251`).

Failure scenario: a literal implementation imports `src/**` into Electron/main
or host, violating the process boundary and paying a large engine graph inside
the app shell. A persistent catalog worker avoids the violation but adds its own
roughly 176–237 MB process floor; a one-shot worker adds repeated boot cost; a
designated live sidecar needs ownership/failover and a zero-live-session policy.
Those shapes have different N=1 and N>1 economics.

**Owner/disposition:** architecture decision before implementation. Choose and
specify a main-supervised worker/service, a designated-sidecar publisher, or a
new extracted engine-free scanner. Include lifecycle, cache freshness, failure,
security, and the singleton's memory in the savings table.

### F4 — The proposed renderer fix does not hard-bound renderer memory

The audit scopes cleanup to transcript and raw-message maps
(`audit:260-272`) and then claims a renderer bound of “~tens of MB” (`:327-328`).
Clean close makes that impossible without a broader disposal path:

- `Host.closeSession` kills the sidecar, evicts replay, marks the row clean, and
  emits only a host status (`app/host/host.ts:452-483`).
- `SidecarSupervisor.killSession` deregisters before the child's late exit
  (`app/supervisor/supervisor.ts:317-325`), and Host documents that production
  receives no exit event for a host-asked kill (`app/host/host.ts:112-120`).
- Main explicitly records that graceful close gets no terminal lifecycle frame
  (`app/main/main.ts:580-588`).
- The renderer's host-event removal path clears preview bookkeeping and shell
  state only (`app/renderer/src/App.tsx:678-688`).

Therefore every frame-keyed store can retain its last full value after ordinary
tab close: transcript, raw log, catalog, extensions, accounts, settings, agent
config, goals/memory, diagnostics, slash catalog, permissions, tasks, and the
rest. Renderer-local `promptDrafts`, `PasteState`, and `HistoryState` are also
keyed by session (`App.tsx:347-353`); a pending paste stores the full unbounded
string (`composerState.ts:91-98,145-161`). The raw-log “~80 MB ceiling” is not a
ceiling: its cap is 8 MiB **per retained session**
(`rawMessageLog.ts:5-11,117-126`) and its session map has no deletion action.

The DOM statement is overbroad in the other direction: at most three workspace
panels are mounted (`workspaceLayout.ts:3-4`), so live DOM does not simply double
all retained session data. The proposed −150–500 MB has no heap/DOM snapshot.

Failure scenario: an operator repeatedly opens and clean-closes sessions. Even
after transcript row caps land, snapshots, drafts, histories, pending pasted
bodies, and any missed transcript/raw entries accumulate for the renderer's
whole lifetime; “Full stack: hard-bounded” remains false.

**Owner/disposition:** define one `session-dispose` action driven by host clean
close/removal and fold it through every per-session reducer plus renderer-local
state. Decide separately what must survive park (open tab) versus close/remove.
Verify with heap snapshots and explicit per-row, per-byte, per-session, and
mounted-panel bounds.

### F5 — The park state-loss contract is materially inaccurate

The state-loss list says model/effort/fast overrides die across park and treats
permission grants/mode as session-scoped (`audit:393-402`). Source disagrees:

- standard `/effort` values persist to `userSettings`
  (`src/commands/effort/effort.tsx:16-27`), and sidecar construction reloads
  `getInitialEffortSetting()` (`app/sidecar/sessionController.ts:195-207`);
- validated always-allow selections reattach engine-minted permission updates,
  which the engine applies and persists (`app/sidecar/sidecarServer.ts:1820-1829`;
  `src/utils/permissions/PermissionPromptToolResultSchema.ts:95-106`). Only
  destination-specific session updates die.

Model override and fast mode are in-memory in the current desktop path; mode and
session-destination permission state need their own rows. “Permission grants” is
not one persistence class.

Failure scenario: the operator ratifies persistence work or accepts a silent
reset based on the wrong matrix. In reality effort survives and can affect newly
spawned sessions, while permission survival depends on update destination.

**Owner/disposition:** rebuild the inventory field-by-field and by
`PermissionUpdate.destination`; prove park→restore via the real public path.

### F6 — Bundling is an experiment, not a zero-blocker implementation

The audit calls the sidecar bundle “measured, zero blockers” (`audit:273`) while
the same paragraph admits unresolved feature-set semantics, staleness wiring,
an unvalidated real-session lane, and no packaged-app lane (`:281-285`). The
operator still must choose a feature set (`:473`). Production currently spawns
the TypeScript entry and uses that path as an orphan identity marker
(`app/main/main.ts:364-382`). The scratch bundle and raw output are not retained
(F1).

Failure scenario: an import-only bundle boots but fails on resume, a native or
dynamic module, a real turn, transcript backfill, feature parity, or orphan
identity/reaping. Calling these “costs” rather than blockers invites a build
session to discover architecture during implementation.

**Owner/disposition:** downgrade lever 5 to a spike. Keep the build script, then
prove ready→submit→permission→result, real restore, backfill worker, native/tool
paths, hardening, exact feature matrix, packaged path, and orphan reaping before
ranking it as shippable.

### F7 — `messageCount` is not merely unknown for fresh rows; it is absent globally

The rider says the catalog is spawn-frozen and fresh sessions uniquely default
to zero (`audit:181-189`). Those premises conflict with current source and with
the audit's own RAM section:

- the sidecar refreshes the catalog every 30 seconds while attached
  (`app/sidecar/sidecarServer.ts:443-451,2310-2332`);
- the bounded loader explicitly does **not** populate `messageCount`
  (`app/sidecar/sessionsCatalogDomain.ts:8-16`), then maps the lite loader's zero
  through (`:180-186`);
- “Most active” therefore falls back to modified time for every bounded-catalog
  row (`app/renderer/src/sessionsCatalogState.ts:310-325`).

The stale “spawn-frozen” protocol comments at `app/shared/protocol.ts:1883-1884`
and `:1924-1928` are doc drift, not current runtime truth.

Failure scenario: changing `number` to `number | null` makes all bounded catalog
rows null and still does not create a useful activity sort or chip. The product
bug survives under a more honest type.

**Owner/disposition:** either fund a bounded real-count seam or remove “Most
active” and the message chip. Correct the protocol comments in the same session.

### F8 — The safe-cut total includes a breaking product decision

The ~1,100 “mechanically cuttable now” total (`audit:29-31`) can only reach that
order by including the 90–140 lines of four `.result` families. But the audit
correctly says those frames are the only negative acknowledgment for their verbs
and calls removal versus failure UI a fork (`:116-135`). `protocol.ts` is a
versioned wire contract: repository rules require additive changes, with a
version bump for a breaking shape (`CLAUDE.md:248-253`; `protocol.ts:58-59`).

The line accounting is also not literal deletion size: the stale-script subtotal
counts roughly 682 source lines but omits the checked-in 681-line generated
`f2-attach-smoke.js` artifact while still recommending its deletion.

Failure scenario: a “mechanical cuts” session removes union variants and emitted
frames without an operator choice or protocol-version treatment, destroying the
only future-correlatable failure signal.

**Owner/disposition:** publish three totals: safe-now, operator-gated behavior
change, and breaking-v2. Preserve tombstone variants for v1 compatibility or
explicitly fund a version bump; recompute from tracked diff lines.

### F9 — `selectSidebarRows` deletion needs a replacement projection

The audit says residual consumers read only `descriptor.restorable` and that the
pipeline can be deleted after re-pointing the debug snapshot (`audit:75-80`). In
current `App.tsx`, the selector is also the complete descriptor source for
`selectMergedSessionRows` (`:818-830`), feeds workspace-trust joins (`:850-860`),
and drives startup preload (`:895-917`). Its visuals are near-dead; its roster
projection is not.

Failure scenario: a worker follows the prescribed deletion and either breaks the
build or recreates an ad hoc shell-descriptor projection without carrying the
ordering/hydration assumptions and tests.

**Owner/disposition:** split the claim: delete the duplicate visual type/function,
replace the roster half with a named `selectShellDescriptors` (or direct,
well-tested equivalent), then re-estimate the net cut.

## Verification and confidence

- Re-derived cited behavior from current source and migration contracts; no
  source-code change was made.
- Confirmed plain Bun execution evaluates representative `bun:bundle` features
  off, so the audit's feature-gate drift lead is credible.
- Confirmed the stale-script and dark-component reachability claims by repository
  reference search; they are not findings in this review.
- Did **not** rerun the RAM table: the missing retained probe, corpus recipe, and
  raw outputs are F1. Those claims are explicitly **UNVERIFIED**, not failed.
- No full app test battery was run because the reviewed artifact is read-only and
  makes no code-change test claim. Docs-only verification applies to this review
  file.
