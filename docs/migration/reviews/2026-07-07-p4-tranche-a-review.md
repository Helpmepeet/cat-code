# Phase 4 · Tranche A — consolidated review (foundations)

**Date:** 2026-07-07 · **Branch:** `migration` · **Reviewer:** review orchestrator (report-only)
**Scope:** the four Tranche-A foundation commits, each its own commit, reviewed at its exact range:

| Session | SHA | Range | Title |
|---|---|---|---|
| P4-1 | `2209808` | `2209808^..2209808` | Shared primitive kit + ConnectionChip |
| P4-2 | `6f44740` | `6f44740^..6f44740` | AgentIdentity vocabulary |
| P4-3 | `b29469d` | `b29469d^..b29469d` | Settings shell + read-only settings read-seam |
| P4-4 | `4630612` | `4630612^..4630612` | Shell-fidelity true-up |

**How this review ran.** Two independent passes per session, plus a by-layer integration pass:
- **Step 1 — correctness/quality:** the bundled `/code-review` skill at **effort `high`**, report-only
  (no `--fix`, no `--comment`), one target range per session. Each range's finder phase (all 8
  angles) ran as a dedicated high-effort agent; the verify phase (recall-biased,
  CONFIRMED / PLAUSIBLE / REFUTED, REFUTED dropped) was reproduced by the orchestrator against
  source. Per-session separation preserved. Labels below are the skill's own vocabulary.
- **Step 2 — code-vs-plan conformance:** four cold, independent ownership lanes (one per session),
  high false-positive discipline (**keep only confidence ≥ 80**), grading each commit against its
  backlog contract + cross-document constraints (PROGRAM-PLAN §5/§6, SECURITY-MINIMUM incl. HC1–HC4).
- **Step 3 — by-layer integration** (synthesis done by the orchestrator; no extra lane — see §Integration).

**Shared Step-0 baseline (HEAD = P4-4, tranche as landed):**
`bun test app/` → **473 pass / 0 fail** (57 files) · `test:hardening` → **19/19** (+ production path) ·
renderer tsc (`app/tsconfig.json`) → **clean** · sidecar tsc (`app/sidecar/tsconfig.json`) →
**5548 errors, ALL engine-graph (0 in `app/` paths)** → the pre-existing ~5.5k baseline, **no NEW
errors from any P4 commit** (verified: `grep -E '^app/'` over the sidecar tsc output = 0).

**Write-boundary attestation:** `git status --short` was captured at Step 0 and re-checked before and
after synthesis — **byte-identical** both times. The only repository write from this review is this
file. No product/test/config/status file was modified.

---

## 1. Summary table

| Session | code-vs-plan verdict | `/code-review` surviving findings (high) | One-line note |
|---|---|---|---|
| **P4-1** | **GREEN** | 5 — 0 bugs; **2 CONFIRMED / 3 PLAUSIBLE**, all LOW (a11y + dead-code + minor) | Clean presentational kit; `ConnectionDemoBar` cut; ToolInspector reuses projector row shape, zero casts; no HTML/eval; no new frames. |
| **P4-2** | **GREEN** | 5 — **3 CONFIRMED / 2 PLAUSIBLE**, all LOW & **latent** (no consumer yet) | Pure vocabulary over verified-real shapes; fixture fields dropped+flagged. Latent derivation defects will surface at the P4-8/P4-9 join. |
| **P4-3** | **GREEN** (1 kept ≥80, LOW → waive) | 3 — **1 CONFIRMED / 2 PLAUSIBLE**; **2 MEDIUM** (attach-path) + 1 LOW | Security gate airtight; **but** the live read-seam resets engine global cache + is unguarded on attach. Front-runs the P4-5 recipe (unflagged). |
| **P4-4** | **GREEN** | 3 — **2 CONFIRMED / 1 PLAUSIBLE**, all LOW (reuse/efficiency) | Clean REPLACEMENT of the provisional shell grammar; HC1 intact; sole wiring delta (Split buttons → existing P3-6 reducers) flagged 3×; no Phase-3 test modified. |

**Tranche verdict: YELLOW** — a structurally sound foundation (boundaries clean, security airtight,
shell replaced, primitives reusable, all tests green), gated on two MEDIUM P4-3 read-seam items that
must be owned **before P4-5 canonizes the domain-read-seam recipe**, plus latent P4-2 derivation
defects that need an owner before P4-8/P4-9 consume them. Nothing blocks building on the tranche today.

---

## 2. Per-session sections

### P4-1 · Shared primitive kit — **GREEN**

**Conformance (≥80):** none. Every BUILD / GROUND-RULE / DONE-WHEN item satisfied. `ConnectionDemoBar`
+ `MOCK_CONNECTION` **confirmed cut** (`grep` clean; only a doc-comment reference remains).
ToolInspector imports `ToolUseRow`/`ToolCardStatus`/`ToolDiffProjection` from `transcriptProjector.ts`
and narrows tolerantly with **zero `as`-casts** (only `as const`). ToastHost is a **real provider +
`useToast()` hook** (the prototype's `window.toast` global is gone). No `dangerouslySetInnerHTML` /
`innerHTML` / `eval` / `new Function` in any primitive; all content renders as escaped React text.
No new protocol/socket vocabulary. 36 P4-1 tests reproduce green; renderer tsc clean.

**`/code-review` surviving findings** (all verified vs source; none are correctness or security bugs):

| # | Verdict | Sev | File:line | Finding & failure scenario |
|---|---|---|---|---|
| 1 | PLAUSIBLE | low | `ConnectionChip.tsx:99–112` | **Inert focusable control (a11y).** When `clickable === false` (a `connecting`/`starting` chip, or any terminal chip rendered without an `onRetry`), the chip is still a `<button>` with `aria-disabled="true"` and `onClick={undefined}` but **no `disabled` attribute** — a keyboard/SR user can focus and "activate" a no-op. Fix: render a `<span>` (or add `disabled`) when not clickable. |
| 2 | CONFIRMED | low | `ConnectionChip.tsx:29,40` | **Dead union member.** `ConnChipVisual`'s `'connected'` arm and `CONN_STATES.connected` are never produced (`ready → null`). **Likely intentional** — the contract says "keep `CONN_STATES` as the prototype's visual vocabulary," so the full 4-state table is deliberate parity → **waive** (or drop `connected` if the kept-vocabulary rationale doesn't need it). |
| 3 | CONFIRMED | low | `Chip.tsx:90–92, 121–123` | **Redundant guard + dead branch.** `Children.toArray()` already strips nullish children and assigns stable keys, so the `.filter(child !== null && child !== undefined)` never removes anything and `keyFor`'s `chip-${index}` fallback is unreachable. Cleanup only. |
| 4 | PLAUSIBLE | low | `MentionPicker.tsx:120` | **Duplicate React key.** `key={item.value ?? item.label}`: two items sharing a label with no `value` (two agents named "reviewer"; duplicate basenames) collide → dup-key warning + `activeIndex` highlight can mis-reconcile on re-filter. No crash. |
| 5 | PLAUSIBLE | low | `ToastHost.tsx:64–65, 122–125` | **Evicted-toast timer clears late.** A toast dropped by the `MAX_TOASTS` cap keeps its expiry `setTimeout` in `timers.current` until it fires a now-no-op `dismiss` (~duration later). Bounded, self-healing (unmount clears all). |

**Observations (non-blocking, disposition noted):**
- `theme.css` bundles **forward tokens** for P4-3 (`--color-source-*`) and P4-4 (`--accent-soft`) in
  the P4-1 commit — disclosed in the commit message and comment-labeled per hunk; additive,
  behavior-inert. **Accept.**
- **Commit hygiene:** the P4-1 commit also deletes `docs/migration/process/{HANDOFF,REVIEW-PROMPT}.md`
  and renames four report docs under `docs/migration/reports/`. Not product code; ideally a separate
  docs commit. **Note only.**

---

### P4-2 · AgentIdentity — **GREEN**

**Conformance (≥80):** none. Pure module, **zero engine imports** (shapes re-declared locally per the
isolation idiom). Every mapped field traced to a real shape (`sessionState.ts`,
`workerUxSummary.ts:72–112`, `LocalAgentTask.tsx`, `InProcessTeammateTask/types.ts`,
`RemoteAgentTask.tsx`, `BackgroundTaskStatus.tsx`). Fixture-only vocabulary **dropped + flagged**
(`DROPPED_PROTOTYPE_AGENT_IDENTITY_FIELDS`, `agentIdentity.ts:246–253`). 9 tests green; renderer tsc
clean. 471 lines assessed proportionate. **No anchor drift.**

**`/code-review` surviving findings** — all LOW and **latent**: P4-2 has **no consumers yet** (P4-8/P4-9
are the join), so none crash in this tranche; each is a defect the join would inherit. Verified vs source:

| # | Verdict | Sev | File:line | Finding & failure scenario |
|---|---|---|---|---|
| 1 | CONFIRMED | low·latent | `agentIdentity.ts:377–393` | **Backgrounded-running local agent shows as `running`, not `background`.** `stateFromTaskStatus` consults `isBackgrounded` **only in the `pending` arm**; `case 'running'` returns `'running'` regardless. So a running backgrounded local agent (`status:'running', isBackgrounded:true`) is painted identically to a foreground one. Cross-family inconsistency: `deriveAgentToolState:353` **does** map `run_in_background + running → 'background'`, so the same concept is `background` via the tool path and `running` via the task path. |
| 2 | CONFIRMED | low | `agentIdentity.ts:172–179, 37` | **Dead / unwired state `waiting`.** `'waiting'` ("Waiting on orchestrator", purple) appears only in the union + meta table; no derivation function returns it. Either dead vocabulary or a missing wire for a real orchestrator-defer state. **[two-strikes — see Integration §4]** |
| 3 | CONFIRMED | low·latent | `agentIdentity.ts:309–310` vs `workerUxSummary.ts:78–93` | **Divergence from the engine's own label fn.** `deriveAgentModeWorkerState` collapses prior-origin to `resumable === true ? 'resumable' : 'stale'` (early return), forcing **`'stale'` for `resumable === undefined`**; `getWorkerStatusLabel` uses explicit `=== true`/`=== false` guards **with a fall-through** to synthesis/status. `resumable?: boolean` and `origin?: 'current'|'prior'` are **both optional** (`sessionState.ts:25–26`) → reachable. P4-2 — the shared vocab P4-8/P4-9 consume — disagrees with the engine for `prior + undefined-resumable`. (The main construction path `sessionState.ts:422–424` sets `resumable`, so today's primary path is covered; widened/other sources bite.) |
| 4 | PLAUSIBLE | low | `agentIdentity.ts:314` vs `:388–391` | **Failure severity reads differently by source family.** A failed/killed **worker** → `'attention'` (yellow); a failed **task** → `'failed'` (red), killed → `'stopped'`. The worker side is faithful to `getWorkerStatusLabel` semantics, so this is a consistency note, not a bug — flagged for the P4-8/P4-9 owner to reconcile the mixed-roster look. |
| 5 | PLAUSIBLE | low·latent | `agentIdentity.ts:381–393` | **No `default` arm → `undefined` on an unknown status.** `stateFromTaskStatus` relies on `TaskStatus` being exactly 5 members. The source type is widened (`Record<string, unknown> & {…}`), so a runtime status outside the union falls off the end → `agentStateMeta(undefined) → AGENT_STATE_META[undefined] → undefined` → a P4-8/P4-9 consumer reading `.label`/`.icon` gets a blank pill or a crash. Add an exhaustiveness assert / default. |

---

### P4-3 · Settings shell + read-only read-seam — **GREEN** (1 kept ≥80, LOW → waive)

**Conformance (≥80): 1 kept, LOW, disposition WAIVE / reconcile-at-P4-5.**

> **[P4-3-C1] The read-seam front-runs P4-5's canonical recipe without flagging it** (confidence 90, LOW).
> Violated clause: Standing rules ("**P4-5 … builds the FIRST domain read-seam and sets the recipe;
> later domains copy it**", backlog ~L67). The commit message and all code comments (grepped) ground
> the seam in the *already-shipped* P2-4 `permissionDomain.ts` / C3 `permission.context` template
> (`settingsDomain.ts` header; `settingsState.ts` "exactly like `permissionState.ts` … the recipe this
> copies") but **never note that P4-5 is the designated recipe owner** and that this seam front-runs it.
> Scenario: if P4-5 later designs the seam differently, `settings.snapshot` forks the recipe.
> **Why waive:** P4-3 copies the real, shipped C3 precedent P4-5 will itself copy — fidelity-to-precedent,
> not a divergent invention; fork risk is low. Recorded as an explicit `reconcile at P4-5` item (§3.3).

**Security hard gate — PASS (airtight).** `settings.snapshot` is added to the **outbound** `ServerFrame`
union only — **no new inbound vocabulary, no renderer-authored settings write** anywhere in the diff.
`sendSettingsSnapshot` routes through `prepareOutboundPayload` (clone + JSON-safe) → `send` (the F6
`scanForSecrets` guard on every non-error frame). `buildSettingsSnapshot` reads **only
`Object.keys(layer.settings)`** — never a value — so `env`/`apiKeyHelper` credentials cannot serialize;
setting **names ride as string values** (not object keys), so a setting literally named `apiKey`
neither trips the guard nor leaks. `settingsDomain.test.ts` proves both directions. Directional cap is
correct (`MAX_OUTBOUND_FRAME_BYTES`, not the inbound cap). §5 layer separation holds:
`settingsState.ts`/`settingsDomain.ts` are a distinct layer-3 service, **not fused into the transcript
projector**; the only cast is a benign `settings as Record<string, unknown>` for key-reading. All source
anchors re-verify (`settings.ts:924/376/275`, `constants.ts:7–22/182`). 28 P4-3 tests reproduce green;
0 new sidecar tsc errors.

**`/code-review` surviving findings** (both #1 and #2 share one root: a **live `getSettingsWithSources()`
disk/platform read on the attach path**):

| # | Verdict | Sev | File:line | Finding & failure scenario |
|---|---|---|---|---|
| 1 | PLAUSIBLE | **MEDIUM** | `sidecarServer.ts:836–860` (`sendSettingsSnapshot`); `index.ts:167–169` | **Unguarded settings read mid-attach → zombie connection + skipped history.** Unlike the sibling permission snapshot (in-memory `appStateStore`, cannot do I/O), `getSnapshot()` performs a fresh disk **+ platform** read on every attach with **no `try/catch`**. It runs inside `addConnection` **after** the connection is added to `this.connections` and **before** `sendHistoryReplay`. Simple FS errors are caught internally, but a policy/MDM read (macOS plist / Windows registry / remote cache) or a non-ENOENT FS error can throw → the exception unwinds out of `addConnection`; `index.ts` never runs `socketState.set()` (so `data`/`close` handlers `.get()` → `undefined` → no-op and **never clean up the zombie**), the connection stays in the broadcast set, and **restored history is silently skipped** — the renderer shows a live-looking session with no transcript on a dead socket. Consequence CONFIRMED; trigger PLAUSIBLE. **Fix:** wrap the read (skip the frame on error, mirroring the existing `if (!this.settings) return`). |
| 2 | CONFIRMED | **MEDIUM** | `settingsDomain.ts` (`getSnapshot`) → `settings.ts:924–935, 941` | **"Read-only" seam mutates engine global state on every attach.** `getSettingsWithSources()` calls `resetSettingsCache()` as its **first line** (`settings.ts:927`), wiping the engine's process-global `sessionSettingsCache`/`perSourceCache`/`parseFileCache` and re-parsing every settings file — against the engine's documented invariant "**settings changes require restart, so cache is valid for entire session**" (`settings.ts:941`). Every renderer attach/reload therefore (a) pays a full settings re-parse on the hot attach path and (b) resets the engine's session cache as a side effect, so the **next** engine settings read re-parses disk and can pick up a mid-session edit the engine was never designed to react to. Side-effect CONFIRMED; the destabilization is PLAUSIBLE and narrow. **Fix:** read the snapshot **once at spawn** (cache it in the domain) or via a non-cache-resetting read — this also fixes #1. |
| 3 | PLAUSIBLE | low·latent | `SettingsField.tsx:97` (`SourceBadge`) | **Confidently-wrong default provenance.** `SourceBadge` silently defaults to the **`userSettings`** label + styling when both `source` and `meta` are omitted. Every in-commit caller passes a source, so it's latent; a future P4-12 panel that renders `<SourceBadge origin={x} />` without a source gets a badge reading **"User"** — a wrong provenance rather than a visible gap. Prefer rendering nothing / failing loud. |

---

### P4-4 · Shell-fidelity true-up — **GREEN**

**Conformance (≥80):** none.
- **REPLACEMENT, not a third grammar:** the provisional static 240px roster `<aside>` is fully removed
  and replaced by the prototype's spacer + fixed hover-rail; row states moved to established tokens
  (`bg-accent/10`, `text-accent-soft`). No provisional grammar coexists.
- **HC1 intact:** no cwd/path authoring; workspace grouping derives from `descriptor.cwd` (read truth);
  the prototype's cwd-authoring per-workspace "+" was **deliberately omitted citing HC1** (§0 flag).
- **No re-wiring beyond one flagged delta:** the only wiring-adjacent change is new TabBar **Split/Unsplit
  buttons** calling the **pre-existing** P3-6 reducers `splitWorkspacePanelWithSession` /
  `closeWorkspacePanelAt` (a new UI entry point to existing wiring, **flagged 3×** — `App.tsx:43–47`,
  TabBar prop doc, STATUS §0). HostEvent projection / `activeSessionId` / ⌘1-9 handlers unchanged.
- **No Phase-3 test modified** (`git log -p 4630612^..4630612 -- '*.test.*'` is empty); 56 shell tests
  pass **unmodified**. Renderer tsc clean; 0 new sidecar errors; hardening 19/19.
- **Visual-fidelity evidence exists** (per-surface before/after in `STATUS.md:200` + code §0 flags);
  live pixel side-by-side correctly deferred to operator GUI acceptance (row honestly marked 🟡, not ✅).

**`/code-review` surviving findings** (all LOW reuse/efficiency; finder confirmed reducer signatures,
`panelCount < 3 == MAX_WORKSPACE_PANELS`, prop threading, hover-timer cleanup, and unchanged HostEvent/⌘1-9):

| # | Verdict | Sev | File:line | Finding & failure scenario |
|---|---|---|---|---|
| 1 | CONFIRMED | low | `WorkspacePanels.tsx` `basename()` | **Helper duplicated 4×** (also `Sidebar.tsx`, `TabBar.tsx`, `debugStateReport.ts`). A future path-parse fix (UNC path, trailing-dot segment) applied to one copy makes Sidebar group labels and WorkspacePanels project pills derive workspace names differently for the same cwd — silent divergence. Extract one shared helper. |
| 2 | CONFIRMED | low | `TabBar.tsx:~136, ~171, ~177` | **Panel cap hardcoded.** TabBar uses literal `3` (`panelCount < 3`) and SplitIcon branches on `=== 1`/`=== 2`, duplicating `MAX_WORKSPACE_PANELS` (imported in `App.tsx`, not here). Raise the cap to 4 → App allows a 4th panel but TabBar hides the Split button at 3 and SplitIcon renders an empty `<svg>` — silent coupling break, no type error. Import the constant. |
| 3 | PLAUSIBLE | low | `Sidebar.tsx` (render body) | **Search recomputes without memo.** `query`/`filtered` (`rows.filter`) and `groups` (`groupByWorkspace` → O(n log n) Map build + `localeCompare` sort) run in the render body on every render/keystroke (and every parent re-render, frequent under HostEvent projection). Laggy search on a large roster. `useMemo` over the roster. |

---

## 3. Tranche-A integration (by-layer)

Reviewed as a **foundation layer** the Tranche-C/D work builds on. Inputs: all four diffs, all four
conformance reports, all Step-1 surviving findings, and the downstream contracts each join feeds.

### 3.1 Enumerated joins

| Join | Produced contract | Clean / reusable / named / discoverable? | Risk to downstream |
|---|---|---|---|
| **P4-1 primitives → every C domain** | `useToast()` provider, `BannerStack` (reauth mounts here), `Chip`/`ChipStrip`, `MentionPicker` (data-source-agnostic), `ToolInspector` (projector row shape, zero casts) | **Yes** — real provider APIs, named, discoverable. | Low. `ChipStrip` is a *generic* reinterpretation of the prototype's composer-specific rail (flagged for P4-0); the a11y inert-button pattern (P4-1 #1) will propagate if copied. |
| **P4-2 `AgentIdentity` → P4-8 / P4-9** | `deriveAgentDisplayVocabulary(source) → {identity, type, state}` | Named + typed, **but** the derivations carry the latent defects (P4-2 #1/#3/#5). | **Medium-latent.** P4-8/P4-9 inherit: backgrounded-running mislabel, prior/undefined-`resumable` divergence from the engine's own label fn, and `undefined` on an unknown status. These *are* the join. |
| **P4-3 Settings-shell primitives → P4-12** | `Field` / `SourceBadge` / `ManagedBadge` row API + the `settings.snapshot` read-seam | `Field` API clean + named. | **Medium.** P4-12 inherits SourceBadge's wrong-default provenance (P4-3 #3) and the read-seam's cache-reset + unguarded-attach behavior (P4-3 #1/#2). |
| **P4-4 trued-up shell grammar → every C domain visual check** | The prototype chrome (rail/expand, logo, search, cwd-grouping, tab + splitter chrome) + established tokens | **Yes** — REPLACEMENT confirmed; C domains render inside it. | Low. |

### 3.2 §5 no-god-object

- **P4-1 primitives are pure presentation** — type-only imports, no store, no engine data of their own,
  no new frames. ✔
- **P4-3 read-seam + selectors are a separate layer-3 service, NOT fused into the transcript projector**
  (`settingsState.ts` explicitly out of `transcriptProjector.ts`; `settingsDomain.ts` is a distinct
  sidecar capability). ✔
- **ToolInspector reuses the projector row shape with ZERO casts.** ✔

**No-god-object: GREEN.** (Caveat unrelated to layering: the P4-3 read-seam's cache-reset side-effect
means the *layer-3 read* mutates engine global state — a boundary-cleanliness issue tracked as a
blocker below, not a layering violation.)

### 3.3 Read-seam ordering — **explicit `reconcile at P4-5`**

P4-5 (Accounts) is the intended owner of the **canonical domain-read-seam recipe** every later domain
copies; **P4-3 front-runs it** and does **not** flag that it does so (conformance **[P4-3-C1]**, waived).
Compounding this, the P4-3 seam has two shape problems P4-5 must **not** inherit (blockers B1/B2 below).

> **RECONCILE AT P4-5 (recorded action):** when P4-5 sets the recipe it must (1) **cite P4-3 as a prior
> C3 read-seam consumer** and unify the two rather than fork; (2) **not adopt a live, cache-resetting,
> per-attach read** — the recipe should read a domain snapshot **once at spawn** (or via a non-mutating
> read) and guard it; (3) confirm every read-seam is `secretGuard`-clean by construction (P4-3's
> keys-only design is the model to keep). If P4-3 is fixed first (B1/B2), P4-5 simply adopts the fixed
> shape.

### 3.4 Two-strikes

| Repeated finding | Where it appeared | Disposition |
|---|---|---|
| **`waiting` state is unreachable** (`agentIdentity.ts:172–179`) | P4-2 conformance (sub-threshold) **and** P4-2 `/code-review` #2 | **Named owner: P4-8** — wire `'waiting'` to the real orchestrator-defer condition when the Orchestrator UI is built, **or** delete it as unused vocabulary. Recorded here so it does not recur silently a third time. |
| **Live `getSettingsWithSources()` on attach** | P4-3 `/code-review` #1 **and** #2 (one root, two distinct consequences) | Kept as two findings (crash-path vs global side-effect); **shared owner P4-3**, single fix (read-once-at-spawn) addresses both. |

### 3.5 Tranche verdict — **YELLOW**

Tranche A is a **sound foundation to build on**: the three-layer boundary is respected, the security
gate is airtight (outbound-only settings seam, keys-only redaction proven both ways, correct directional
cap, HC1 intact, no re-wiring, all cuts honored), the shell grammar is a clean replacement, the shared
primitives are reusable and named, and every build claim reproduces green. It is **YELLOW rather than
GREEN** because the P4-3 read-seam — the very shape P4-5 is about to canonize for the whole C/D tranche —
carries two MEDIUM defects (global cache-reset side-effect + unguarded attach read), and P4-2's shared
vocabulary carries latent derivation defects P4-8/P4-9 will inherit at the join. None block starting
Tranche C today; all are contained and now owned.

---

## 4. Ranked blockers

Ranked most-severe first. B1–B2 are **should-fix (or explicitly own) before P4-5 canonizes the recipe**;
B3 before P4-8/P4-9; the rest are cleanups with named owners.

**B1 — P4-3 read-seam resets the engine's global settings cache on every attach** · MEDIUM
- *Evidence:* `settingsDomain.ts` `getSnapshot()` → `settings.ts:924–935`, where line **927** is
  `resetSettingsCache()`; invariant it violates at `settings.ts:941`.
- *Failure scenario:* every renderer attach/reload wipes `sessionSettingsCache`/`perSourceCache` and
  re-parses all settings files; a subsequent engine settings read then re-parses disk and can pick up a
  mid-session edit the engine assumes is frozen for the session → subtle behavior divergence + re-parse
  cost on the hot attach path.
- *Proposed owner:* **fix P4-3** — read the snapshot once at spawn (cache in `SidecarSettingsDomain`) or
  use a non-cache-resetting read. **Reconcile at P4-5** so the canonical recipe never bakes this in.

**B2 — P4-3 unguarded settings read mid-attach → zombie connection + skipped history** · MEDIUM
- *Evidence:* `sidecarServer.ts` `sendSettingsSnapshot` (no `try/catch`) runs after `this.connections.add`
  and before `sendHistoryReplay`; `index.ts:167–169` calls `addConnection` then `socketState.set` with no
  guard.
- *Failure scenario:* a throw from the disk/platform read (policy/MDM/remote cache, or non-ENOENT FS)
  unwinds out of `addConnection` → `socketState.set` never runs (so `data`/`close` no-op and never clean
  up), the connection stays a zombie in the broadcast set, and restored history is skipped → renderer
  shows a transcript-less session on a dead socket.
- *Proposed owner:* **fix P4-3** — wrap the read and skip the frame on error (mirror `if (!this.settings)
  return`). Same read-once-at-spawn fix as B1 resolves this too.

**B3 — P4-2 shared vocabulary carries latent derivation defects the P4-8/P4-9 join inherits** · LOW (latent)
- *Evidence & scenarios:* (a) `agentIdentity.ts:377–393` — backgrounded-running local agent → `running`,
  inconsistent with `deriveAgentToolState:353`; (b) `:309–310` vs `workerUxSummary.ts:78–93` —
  `prior + undefined-resumable` forced to `stale`, diverging from the engine's own label fn (fields
  optional at `sessionState.ts:25–26`); (c) `:381–393` — no `default` arm → `undefined` on an unknown
  status → blank/crash in a consumer.
- *Proposed owner:* **fix P4-2** (small, self-contained) **or** reconcile at **P4-8/P4-9** with the fix
  owned there. Decide before those sessions consume the vocabulary.

**B4 — P4-3 read-seam front-runs the P4-5 recipe without flagging it** · LOW → **WAIVE**
- *Evidence:* conformance **[P4-3-C1]** (conf 90); no P4-5/front-run note in commit or comments.
- *Disposition:* **explicit waive** — P4-3 copies the shipped C3/P2-4 precedent P4-5 will itself copy;
  recorded as the `reconcile at P4-5` item (§3.3). P4-5 must cite P4-3 as a prior consumer.

**B5 — P4-3 `SourceBadge` defaults to a confidently-wrong "User" provenance** · LOW (latent)
- *Evidence:* `SettingsField.tsx:97`. *Scenario:* a future P4-12 panel rendering `<SourceBadge>` without a
  `source` shows "User" styling instead of a visible gap. *Owner:* **fix P4-3 or P4-12** (render nothing /
  fail loud when source is absent).

**Non-blocking cleanups (named owners):**
- P4-1: inert focusable ConnectionChip button (a11y) `ConnectionChip.tsx:99–112`; dead `connected` member
  (waive-per-contract); redundant `Children.toArray` filter/`keyFor` `Chip.tsx:90–123`; MentionPicker
  duplicate key `:120`; ToastHost late timer clear `:64–125`. → **owner P4-1** (or fold into P4-0 for the
  composer-facing ones).
- P4-2: `waiting` unreachable → **owner P4-8** (wire or delete; two-strikes §3.4); failed worker/task
  color inconsistency → reconcile at P4-8/P4-9.
- P4-4: `basename` duplicated 4× → extract shared helper; TabBar hardcoded panel cap → import
  `MAX_WORKSPACE_PANELS`; Sidebar search `useMemo`. → **owner P4-4** (or a small shell-cleanup rider).
- Commit hygiene: P4-1 bundled doc deletions/renames → note only.

*Report-only. The operator decides acceptance and dispatches fix owners; no `STATUS.md` rows were flipped.*
