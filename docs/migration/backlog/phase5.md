# Migration backlog — Phase 5 (make it a real local app)

**Generated 2026-08-17. Rescoped 2026-08-19 by operator decision: sixteen
sessions collapsed to four.**

Phase 4 is closed by product acceptance. The original Phase-5 backlog was
written as a *product release* plan: signing, notarization, an update feed, a CI
gate, state-migration matrices, and a release-candidate certification. Nearly all
of that machinery exists to protect **strangers on other machines**, and this
program has none. Cat Code is a private fork with one human owner, one machine,
and a checked-out repository.

So Phase 5 is now scoped to the thing the operator actually wants and does not
have: **a double-clickable Cat Code in the dock that runs without a terminal,
without Vite, and without clobbering the terminal Cat Code that shares its
state.**

## The decision that governs this rescope

**Distribution scope: local only. One machine, one user, no distribution.**
Version authority is the git SHA. There is no release, no channel, no feed, and
no installer for anyone else.

Ruled by the operator 2026-08-19. Every waiver below follows from this line
rather than from fatigue: if distribution scope ever changes, the waived
sessions come back as written, and this ruling is what tells you to reinstate
them. Phase 5 is still a **feature freeze** — do not reopen Phase-4 feature work
unless a Phase-5 check proves the current behavior prevents ordinary local use.

## How to use

Paste one session block into a fresh agent session. Respect the dependency
order. Each worker echoes its Model/Difficulty header before starting and updates
only its own row in `docs/migration/STATUS.md` as its final bookkeeping step.

## Standing rules

- Read `CLAUDE.md`, your `STATUS.md` row, this Standing-rules section, and the
  focused source maps named by your prompt before changing files. Source is
  authoritative; dated reports route investigations but do not override current
  code.
- Preserve the locked architecture: Electron main + Electron-free supervisor and
  host, one Bun sidecar per session, Unix-domain sockets, raw `AppSessionEvent`
  frames, the two-id model, and die-with-window v1. Packaging this product does
  not redesign its topology.
- Preserve `decisions/SECURITY-MINIMUM.md`: default-deny preload, strict
  sidecar-local inbound validation, T4/T5a/T6/T6b/T7, directional frame limits,
  engine-only secrets, and `secretGuard` on outbound data. **A single user is not
  a reason to relax this.** The renderer displays model output, and hostile
  content reaches it through fetched pages, repository files, and tool results.
  The threat model is injection, not other users.
- Building a local artifact is allowed. Installing over the operator's active
  application, or any action against live credentials or external services,
  requires explicit authorization for that exact action. Never put credentials in
  repository files, logs, fixtures, or prompts.
- The shared working tree is multi-writer. Stage only explicit paths, never
  stash, never clean, never overwrite work you did not create, and commit to
  `migration` as authorized by the repository rules. Do not push unless asked.
- A packaged-build claim must exercise the packaged branch. A Vite/dev launch is
  not evidence: `app.isPackaged` changes renderer loading, environment flags,
  resource paths, and diagnostics behavior. Keep the executable-name assumptions
  in `CLAUDE.md` intact for development builds.
- Use isolated temporary config homes for anything touching persisted state.
  Never test destructive behavior against the operator's live `~/.cat-code`.
  Fixtures must contain no credentials or private transcript content.
- For every changed area, use `CLAUDE.md` §3 for the current verification
  commands. Desktop changes require `bun test app/`, app typecheck, scoped sidecar
  typecheck, hardening when the boundary is touched, and renderer build when
  renderer inputs change. Never use raw known-red root or sidecar typecheck as a
  false gate.
- Every `🖐 GUI` session reads `docs/migration/process/GUI-VERIFICATION.md`. The
  worker completes headless work, then stops and prints exact operator steps. It
  does not launch or drive the GUI without per-run authorization.
- Any process a test starts must be accounted for and reaped by exact PID. Never
  use sweep kills.
- A session created by a peer treats that peer's instruction as its session block
  and still updates only its own STATUS row, which stays the record. If the
  creator asked to hear back, send it one message when you finish or stop, saying
  so if you could not finish. The operator may talk to you in your tab; their word
  outranks the instruction.

## Verified starting point

Source-verified 2026-08-17, re-confirmed 2026-08-19. Re-check before acting.

> **P5-1 landed 2026-08-19 (`35dbd8ec`).** The packaging bullets below describe
> the state P5-1 STARTED from and are kept as that record, not as current truth:
> packaging tooling now exists (`bun run --cwd app package`) and the sidecar is
> bundled. P5-5c and P5-7 should read the P5-1 row in `STATUS.md` for what is
> actually there now. Everything else in this section still holds.

- **No packaging tooling exists at all.** No `electron-builder`, `electron-forge`,
  `@electron/packager`, or `electron-updater` in `app/package.json` or the root
  package. `app/package.json` is private, reports version `0.0.0`, and has no
  package, distribution, signing, publication, or update script. The root CLI
  reports a separate `2.1.87` (`package.json:3`); there is no shared desktop
  version authority.
- `app/scripts/build-electron.ts:43-56` emits loose main/preload JavaScript
  bundles, and `app/renderer/vite.config.ts:9-22` emits `renderer/dist`. No
  application bundle, archive, or artifact manifest is produced.
- The packaged code branch is real: `app/main/main.ts:227-230` keys on
  `app.isPackaged`, loads `renderer/dist/index.html` in packaged mode
  (`:1306-1328`, `:1453-1460`), and selects the production preload
  (`:1171-1176`).
- **The sidecar is not packaged, and this is the core of P5-1.** Main resolves
  `bun` from `PATH` unless `CATCODE_BUN_BIN` is supplied and launches repository
  TypeScript entrypoints (`app/main/main.ts:973-1035`); `app/sidecar/index.ts:18-46`
  imports the root engine source directly. `app/main/mainDecisions.ts:40-49`
  explicitly calls it the unbundled desktop sidecar. A `.app` built today would
  still silently depend on the checkout and on `bun` being on `PATH`.
- `bun run --cwd app test:hardening` is valuable boundary evidence but not an
  installed-artifact test: its harness launches the source package and forces the
  packaged branch (`app/scripts/hardening-smoke.ts:22-28`,
  `app/scripts/run-hardening-smoke.ts:30-68`).
- The only signing today is ad-hoc signing of the copied development Electron
  bundle (`app/scripts/prepare-dev-electron.ts:78-102`). Under the local-only
  ruling that remains sufficient; no production certificate or entitlement is
  needed.
- **Desktop-owned persisted state is four files**: `registry.json`,
  `sessions-catalog.json`, `state.json`, `cat-code-diagnostics.json`. Three are
  derived caches or bounded rotating logs. This is why the state-migration
  sessions are waived — see the waiver table. The irreplaceable state
  (transcripts, Codex vault, memory) is **engine**-owned and predates the desktop
  app.
- Registry and renderer-owned records already have independent v1 schemas, and
  unknown versions generally fall back or move aside rather than migrate. That
  fallback behavior is the accepted local-use policy, not a gap to close.
- **Engine migrations are not proven to run from a desktop-only launch.** Normal
  engine migrations run from the CLI pre-action (`src/main.tsx:335-368`,
  `:991-996`), while desktop startup reaches shared `init()` through
  `app/sidecar/initializeRuntime.ts:35-43`. P5-5c owns this.
- TUI/desktop shared-write safety has real foundations, including
  fresh-read-under-lock settings updates, but desktop sidecars do not call the
  terminal's `registerSession()` and are absent from `cat-code ps`
  (`docs/migration/decisions/REGISTRY.md:332-337`). Same-transcript concurrent
  resume and shared cleanup/account ownership are not certified. P5-5c owns this.
- Performance groundwork exists and must be reused rather than rebuilt.
  `memory:trajectory` supports four workloads and analyzes slope/acceleration
  against checked-in thresholds (`app/scripts/renderer-memory-trajectory.ts:63-78`,
  `app/scripts/rendererMemoryTrajectory.ts:443-529`); RAM corpus, one-sidecar,
  cohort, and fleet probes live in `app/scripts/ram-{corpus-gen,probe,measure,fleet}.ts`.
  The retained renderer trajectory is pre-CC-59-remediation and failed, so it is
  not current evidence.
- Private operational logs and support export already use closed schemas, bounded
  retention, redaction, and explicit exclusions. Keep those contracts intact
  under packaged paths; do not replace them with wholesale stderr, transcripts,
  settings, or third-party crash uploads.

## Dependency graph

```text
P5-0 local-use contract
  └─> P5-1 package assembly + packaged launch   (absorbs old P5-2)
        ├─> P5-5c TUI/desktop coexistence
        └─> P5-7 packaged safety, leak, honest-failure  (absorbs old P5-9, P5-11)
```

P5-5c and P5-7 are independent of each other and can run concurrently once P5-1
produces an artifact. There is no integration gate: Phase 5 is done when all four
rows are green and the operator can open the app from the dock.

---

## P5-0 — Local-use contract

🧠 **Model: ANY · Difficulty: 3/10**

```text
Work in /Users/pt/cat-code on branch migration. This is P5-0. Echo the Model/Difficulty header before starting.

Write a SHORT decision record under docs/migration/decisions/ fixing the local-use contract for the Cat Code desktop app. Target one page. This is deliberately not a release contract: the operator has ruled distribution scope to be local only, one machine, one user, no distribution.

Settle exactly these, and nothing more: application identity and bundle id; version authority (git SHA, and how it reaches the built app given the root CLI reports 2.1.87 while app/package.json reports 0.0.0); artifact type and output location; signing posture (ad-hoc local signing is expected to suffice, confirm against current macOS behavior for a locally built Electron app the operator launches themselves); how the operator updates (rebuild from the checkout) and the explicit absence of any auto-update path; what happens to persisted desktop state on an unknown or newer version (the current move-aside/fallback behavior is expected to be ratified as policy, not replaced); and which steps stay operator-owned.

Hard constraints: preserve the locked topology and SECURITY-MINIMUM; no publication, credential use, or external account action; do not choose a mechanism unsupported by current Electron/Bun facts. Current source and app package metadata are authoritative.

Record the waived Phase-5 sessions and the single reason (local-only scope) so a future reader can reinstate them if distribution scope ever changes. Do not re-argue each waiver.

Done means P5-1, P5-5c, and P5-7 have no ambiguity about identity, version, signing, or state policy, and the P5-0 STATUS row records the result.

Verification: docs battery (`git diff --check`, `bun run maps:lint`) and existence checks for every cited path. Do not change application code.
```

## P5-1 — Package assembly and packaged launch

🧠 **Model: ANY · Difficulty: 8/10 · 🖐 GUI**

*Absorbs the original P5-2. This is the only substantial new engineering in
Phase 5.*

```text
Work in /Users/pt/cat-code on branch migration. This is P5-1. Echo the Model/Difficulty header before starting and read docs/migration/process/GUI-VERIFICATION.md before the live section.

Produce a double-clickable Cat Code application that launches from the dock and runs the real packaged branch with no repository checkout, no Vite server, no development-only environment, and no assumption that bun is on PATH. Conform to the P5-0 local-use contract.

Start from the verified fact that the sidecar is NOT packaged today: app/main/main.ts:973-1035 resolves bun from PATH unless CATCODE_BUN_BIN is set and launches repository TypeScript entrypoints, and app/sidecar/index.ts:18-46 imports root engine source directly. Bundling or vendoring the sidecar and its runtime so a launched .app is self-contained is the heart of this session. Choose the smallest mechanism that achieves it; a new packaging dependency is likely needed and requires operator approval before you add it.

Own package configuration, resource inclusion, icons and metadata, version injection per P5-0, and a deterministic output location that a prior build's stale files cannot leak into.

Do NOT build an artifact manifest enumerating packaged contents. A manifest proves contents to someone who cannot inspect the build; the operator can, and the launch test below already fails if a required resource is missing. The one content check worth automating is a scan that no credential, private fixture, or repository-only file landed in the bundle. That check belongs to this session; P5-7 does not repeat it.

Then prove it runs. Exercise the real N-process runtime from the built artifact: create two sessions in distinct workspaces, run a tool and a permission round-trip, switch sessions, and close/reopen as allowed by die-with-window v1. The automated proof must fail if a required packaged resource is omitted or if packaged startup silently falls back to development paths. Assert the renderer bundle and the sidecar were both loaded from inside the bundle rather than from the checkout: that single assertion is what makes this a real packaged proof.

Do not sign with production credentials, notarize, publish, or install over the operator's active application. Ad-hoc local signing per P5-0 is in scope.

Done means one documented command builds the artifact from a clean checkout, stale files cannot leak in from a prior build, no secret or repository-only file is in the bundle, the app launches from Finder with the repository moved aside or renamed, credential-free packaged startup has an automated smoke where practical, the worker prints exact operator steps for the remaining live packaged interaction, every spawned process is reconciled by exact PID, applicable batteries pass, maps are current, and STATUS records what is automated versus operator-observed.
```

## P5-5c — TUI and desktop coexistence

🧠 **Model: ANY · Difficulty: 8/10 · 🖐 GUI**

*Kept intact. This is the only Phase-5 session guarding state that cannot be
rebuilt.*

```text
Work in /Users/pt/cat-code on branch migration. This is P5-5c. Echo the Model/Difficulty header before starting and read docs/migration/process/GUI-VERIFICATION.md before live checks.

Certify that packaged desktop Cat Code and terminal Cat Code can run at the same time against one ~/.cat-code without losing each other's state. The operator does this daily, so this is a real workload, not a hypothetical.

Cover simultaneous processes sharing settings, account/vault state, transcripts, memory, caches, and periodic cleanup; the behavior when both surfaces try to resume the same engine transcript; and whether desktop sidecars belong in terminal process-management views (they do not call registerSession() today and are absent from `cat-code ps`, decisions/REGISTRY.md:332-337).

Settle who runs engine migrations on a desktop-only launch. Engine migrations run from the CLI pre-action (src/main.tsx:335-368, :991-996) while desktop startup reaches shared init() through app/sidecar/initializeRuntime.ts:35-43; a desktop-first launch on a machine whose engine state is behind is not proven to migrate correctly.

There is prior art for the failure mode: P3-5b found a persistPermissionUpdates lost-update race under same-cwd concurrency. Treat shared-file writes as guilty until proven safe.

Preserve the one-process-per-session desktop topology and existing fresh-read-under-lock settings discipline. Do not solve process visibility by exposing desktop control authority to the renderer. Do not use live credentials as fixtures. Any shared-file mutation needs a real two-process probe with fresh reads under the applicable lock.

Done means simultaneous-use and same-transcript rules are enforced rather than documented only, shared writes cannot clobber one another, migration ownership is race-safe, one product exiting does not corrupt the other, isolated packaged/TUI operator steps are exact, relevant engine and desktop batteries pass, and STATUS records the two answers that matter: whether both surfaces may run at once, and what happens when both open the same transcript.
```

## P5-7 — Packaged safety, leak, and honest-failure pass

🧠 **Model: ANY · Difficulty: 7/10 · 🖐 GUI**

*Distilled from the original P5-7, P5-9, and P5-11. Three narrow jobs, not three
audits. Resist the pull to grow this back into a full audit; if you find
something large, report it and let the operator scope it.*

```text
Work in /Users/pt/cat-code on branch migration. This is P5-7. Echo the Model/Difficulty header before starting and read docs/migration/process/GUI-VERIFICATION.md before live checks.

Three narrow jobs against the P5-1 artifact. Do not expand any of them into a full audit; report anything larger instead of absorbing it.

1. PACKAGING SECURITY DELTA. The existing hardening suite already covers the sidecar boundary against source. Cover only what packaging changes: packaged BrowserWindow settings, navigation and window-open policy, CSP behavior under the packaged renderer, and preload exports in the production preload. P5-1 owns the no-secrets-in-the-bundle scan; do not rebuild it here. The threat model is injection through displayed model output and fetched content, not other users, so a single-user product does not relax SECURITY-MINIMUM. Every finding needs a source-verified failure scenario and a focused regression or an explicit accepted residual. Use synthetic secrets and hostile-content fixtures only.

2. LEAK CHECK AGAINST THE PACKAGED BUILD. Reuse app/scripts/renderer-memory-trajectory.ts and the ram-* probes rather than building a soak harness. The retained trajectory is pre-CC-59-remediation and failed, so re-baseline it against the packaged artifact. Check for leaked sidecars/helpers, stale sockets and temp directories, unbounded log or cache growth, and listeners or timers that grow with iterations across repeated session create/run/close and renderer reload. Own exact PIDs; never sweep-kill. A bounded repeated run is enough; a formal soak duration gate is waived.

3. HONEST FAILURE. One rule matters more than a failure matrix: a failed or partial restore must never silently open a fresh session that impersonates the operator's old one. Verify that, plus the handful of cases a local user actually hits: sidecar spawn failure, one sidecar crashing while others run, a corrupt or missing transcript, an unwritable config directory, and expired authentication. Each must end in an honest state: retry, restart, explicit non-recoverable loss, or safe degradation. Preserve the closed diagnostic schemas, bounded retention, and redaction in app/shared/operationalLog.ts, app/main/deliveryTraceSink.ts, and app/main/diagnosticsBundle.ts; raw logs, transcripts, and settings must never become model context.

Done means the packaging delta has regressions or recorded residuals, the packaged build has a current leak baseline with cleanup returning to baseline, the restore-honesty rule is enforced by a test rather than by inspection, misleading copy is corrected, operator steps cover only what is unavailable headlessly, all affected batteries pass, and STATUS records the verdict plus every accepted residual.
```

---

## Merged into surviving sessions

| Original | Now owned by | Why |
|---|---|---|
| **P5-2** Packaged runtime and sidecar smoke | P5-1 | Building the artifact and proving it launches is one loop, not two sessions. Splitting them invites a "packaged" claim with no launch behind it. |
| **P5-9** Soak, resource lifetime, cleanup | P5-7 job 2 | The existing memory-trajectory and ram-* probes already do the measuring. What was missing is a baseline against a packaged build, not a new harness. |
| **P5-11** Failure recovery and support diagnostics | P5-7 job 3 | One rule (no silent fresh session impersonating restore) carries nearly all the value. The other twelve matrix cells are release-support ceremony. |

## Waived — local-only scope

All waived by the operator's 2026-08-19 ruling. **If distribution scope ever
changes, reinstate these as originally written** — the original prompts are
preserved verbatim in the appendix at the end of this file.

| Original | Waived because |
|---|---|
| **P5-3** Signing, notarization, artifact verification | Nobody downloads this. Ad-hoc local signing per P5-0 covers a build the operator launches themselves. Notarization protects a distribution channel that does not exist. |
| **P5-4** Automatic update and live-session lifecycle | The update mechanism is `git pull` and rebuild. An update feed with check/download/apply states, signature validation, and retry is machinery for users who cannot rebuild. |
| **P5-12** Fresh install, update, rollback rehearsal | Rehearses P5-3 and P5-4. Nothing left to rehearse. |
| **P5-13** Release-candidate integration gate | There is no release candidate and no release. Phase 5 ends when the four rows are green and the app opens from the dock. |
| **P5-6** Canonical release test matrix and CI gate | No CI, no PRs, no team. `CLAUDE.md` §3 already defines the battery per area, and a second aggregate gate would compete with it. |
| **P5-5a** Persisted-state compatibility contract | Protects four desktop-owned files, three of which are derived caches or rotating logs. P5-0 ratifies the existing move-aside/fallback behavior in one line instead. The irreplaceable state is engine-owned and covered by P5-5c. |
| **P5-5b** State migrations, upgrade, rollback implementation | Implements P5-5a. An old/current/corrupt/newer fixture matrix at 9/10 difficulty is disproportionate to a rebuildable cache. |
| **P5-8** Performance budgets and reproducible benchmarks | Enforced numeric thresholds exist to stop other contributors regressing you. With one user who notices slowness directly, the measurement tooling is worth keeping and the gate is not. P5-7 keeps the leak measurement. |
| **P5-10** Whole-app accessibility gate | One user, whose needs are known. Keyboard reachability is worth having and is largely built already (TabBar roving focus, overlayFocus, live regions); a VoiceOver, contrast, and scaling certification is for an audience of one who is not asking for it. |

## What Phase 5 does NOT waive

Read this before deciding a surviving session is also skippable:

- **SECURITY-MINIMUM.** Single-user does not mean single-threat. The renderer
  renders model output; injection arrives through fetched pages, repository
  files, and tool results.
- **Anything protecting `~/.cat-code`.** Transcripts, the Codex vault, and memory
  are irreplaceable and shared with terminal Cat Code. That is the whole reason
  P5-5c survives at full scope.
- **The restore-honesty rule.** A fresh session silently standing in for a failed
  restore is data loss wearing a normal face.

---

# Appendix — original 2026-08-17 prompts for the merged and waived sessions

Preserved verbatim from the 16-session backlog generated 2026-08-17, so the
"reinstate as originally written" promise above is actually keepable. The
original file was never committed to git, so this appendix is its only surviving
copy.

These prompts assume the **distributable** scope that the 2026-08-19 ruling
retired. Do not run one because it is here. Reinstating any of them requires the
distribution-scope ruling in P5-0 to change first, and reinstating P5-3/P5-4/P5-12/P5-13
means restoring the original dependency graph and integration gate along with them.

Original dependency graph:

```text
P5-0 release contract
  ├─> P5-1 package assembly ─> P5-2 packaged runtime ─> P5-3 signing ─> P5-4 updates
  └─> P5-5a state-version contract ─> P5-5b upgrade/rollback
                                      └─> P5-5c TUI/desktop coexistence

P5-2 packaged runtime ─> P5-7 security / P5-8 performance / P5-10 a11y / P5-11 recovery
P5-4 updates + P5-5b state + P5-5c coexistence + P5-11 recovery ─> P5-12 rehearsal
P5-6 release test matrix ───────────────────────────────────────────┐
P5-7 packaged security ─────────────────────────────────────────────┤
P5-8 performance budgets ─> P5-9 soak/resource lifetime ───────────┤
P5-10 accessibility ────────────────────────────────────────────────┤
P5-11 failure recovery + diagnostics ───────────────────────────────┤
P5-12 install/update/rollback rehearsal ────────────────────────────┤
                                                                    └─> P5-13 release gate
```

## Original P5-0 — Release contract and distribution decision (superseded by the reduced P5-0)

🧠 **Model: CLAUDE (system-architecture) · Difficulty: 8/10**

```text
Work in /Users/pt/cat-code on branch migration. This is P5-0. Echo the Model/Difficulty header before starting.

Define the binding v1 release contract for the Cat Code desktop app. Phase 4 is feature-frozen by operator acceptance. The output is a decision record under docs/migration/decisions/ that later packaging, signing, update, migration, and release sessions can implement without reopening product scope.

The contract must settle: supported platform/architecture and minimum OS; private/local versus distributable release scope; canonical application identity and version authority; artifact types; signing and notarization posture; release/update channel and source; update-time behavior for live sessions under the locked die-with-window v1 decision; downgrade/rollback and uninstall/data-retention promises; supported version skew with terminal Cat Code; diagnostics/support and crash-report privacy policy; accessibility target; performance/soak machine classes; external credentials and services required; and which steps remain operator-owned shared-state actions.

Hard constraints: preserve the locked topology and SECURITY-MINIMUM; no publication, credential use, or external account action; do not choose a mechanism unsupported by current Electron/Bun packaging facts; distinguish a recommended default from facts only the operator can supply. Current source and app/package metadata are authoritative.

Done means the decision is concrete enough that P5-1, P5-3, P5-4, P5-5a, and P5-12 have no architectural ambiguity, all external prerequisites are explicit, rejected alternatives and consequences are recorded, relevant canonical maps are updated, and the P5-0 STATUS row records the result.

Verification: docs battery (`git diff --check`, `bun run maps:lint`) and existence checks for every cited path. Do not change application code.
```

## Original P5-1 — Reproducible package assembly and artifact manifest (merged into the new P5-1)

🧠 **Model: ANY · Difficulty: 8/10**

```text
Work in /Users/pt/cat-code on branch migration. This is P5-1. Echo the Model/Difficulty header before starting.

Implement a reproducible local packaging path for the dedicated desktop app, conforming to the P5-0 release contract. The output must be a clean artifact assembled from declared inputs, not a renamed development Electron or a Vite-dependent bundle.

Own the package configuration, resource inclusion, icons/metadata already approved by the release contract, version injection, deterministic output location, and a machine-readable or test-enforced artifact manifest. The manifest must account for Electron main/preload/renderer output, supervisor/host code, the Bun sidecar and every runtime dependency it needs, licenses/notices required by current dependencies, and the absence of repository-only or secret files.

Do not claim runtime success here; P5-2 owns launching the artifact. Do not sign, notarize, publish, or install over the operator's application. No new dependency without operator approval.

Done means one documented command creates the expected unsigned local artifact from a clean checkout, stale files cannot leak in from a prior build, artifact contents are asserted, version/identity match P5-0, no credentials or private state are present, focused packaging tests pass, applicable engine/desktop batteries pass, maps are current, and STATUS is updated.
```

## Original P5-2 — Packaged runtime and sidecar smoke (merged into the new P5-1)

🧠 **Model: ANY · Difficulty: 8/10 · 🖐 GUI**

```text
Work in /Users/pt/cat-code on branch migration. This is P5-2. Echo the Model/Difficulty header before starting and read docs/migration/process/GUI-VERIFICATION.md before the live section.

Prove the P5-1 artifact runs through the real packaged branch with no repository checkout, Vite server, development-only environment, or globally installed Bun assumptions. Exercise the real N-process runtime: create two sessions in distinct workspaces, run a tool and a permission round-trip, switch sessions, close/reopen as allowed by the v1 lifetime contract, and verify the correct sidecar resources and renderer bundle were loaded.

The automated proof must fail if a required packaged resource is omitted or if packaged startup silently falls back to development paths. Capture bounded version, process, resource-origin, and exit evidence without transcript text or credentials. Preserve default-deny preload and packaged diagnostics restrictions.

Done means credential-free packaged startup has an automated smoke where practical, headless package/resource checks pass, the worker prints exact operator steps for the remaining live packaged interaction, every spawned process is reconciled by exact PID, no dev server is involved, failures are loud and actionable, and STATUS records what is automated versus operator-observed.
```

## Original P5-3 — Signing, notarization, and artifact verification (WAIVED)

🧠 **Model: ANY · Difficulty: 7/10 · 🖐 GUI**

```text
Work in /Users/pt/cat-code on branch migration. This is P5-3. Echo the Model/Difficulty header before starting and read docs/migration/process/GUI-VERIFICATION.md before live checks.

Implement the signing and platform-verification pipeline selected by P5-0 for the P5-1 artifact. Repository code may define configuration, validation, local dry runs, and credential-safe environment contracts. Live credential use, notarization submission, upload, or publication is operator-owned and requires authorization at the moment it happens.

The pipeline must fail closed on missing identity, unsigned nested executables, mutated artifacts, wrong bundle identity/version, or an unverified ticket/status. It must cover the Electron executable and the packaged Bun sidecar/runtime components rather than signing only the outer directory. Logs and CI output must never reveal credentials.

Done means unsigned and malformed fixtures are rejected, the exact external prerequisites are documented, a locally verifiable signed artifact path exists when credentials are supplied, operator commands are copy-ready and do not embed secrets, applicable tests/builds pass, and STATUS distinguishes code-complete from any live signing/notarization action not run.
```

## Original P5-4 — Automatic update and live-session lifecycle (WAIVED)

🧠 **Model: ANY · Difficulty: 9/10 · 🖐 GUI**

```text
Work in /Users/pt/cat-code on branch migration. This is P5-4. Echo the Model/Difficulty header before starting and read docs/migration/process/GUI-VERIFICATION.md before live checks.

Implement the update behavior defined by P5-0 using the signed artifact contract from P5-3 and the compatibility contract from P5-5a. The update path must have explicit states for check, available, download, ready, apply, failure, and retry; must not let renderer-authored data select arbitrary update locations or execute payloads; and must preserve the locked die-with-window v1 rule honestly when applying an update ends sidecars.

Use a local test feed or fixture for automated success, no-update, corrupt artifact, signature failure, interrupted download, incompatible state version, and retry behavior. Publishing a real feed is out of scope without authorization. Update UI, if added, must be keyboard accessible and must not claim an update was applied before the relaunched packaged version proves it.

Done means the old packaged version can discover and validate a local newer artifact, unsafe artifacts are rejected, apply/relaunch behavior is exact, sessions and persisted state follow P5-5a, failures recover without a reinstall, privacy-safe diagnostics identify the stage, operator live steps are exact, and all relevant batteries and STATUS updates are complete.
```

## Original P5-5a — Persisted-state compatibility and rollback contract (WAIVED)

🧠 **Model: CLAUDE (system-architecture) · Difficulty: 8/10**

```text
Work in /Users/pt/cat-code on branch migration. This is P5-5a. Echo the Model/Difficulty header before starting.

Define the compatibility contract for every desktop-owned persisted format that installation or update can encounter: host registry, transcript preview/cache, diagnostics indexes, renderer-owned layout/preferences, and any other current desktop config records found in source. Engine-owned transcripts/settings/accounts remain engine-owned, but the contract must name who runs their existing migrations when the desktop launches without a prior TUI launch; do not invent desktop-owned replacements for them.

For each format, record its version authority, compatible read range, migration owner, atomicity/locking requirement, corrupt and unknown-newer behavior, backup/rollback posture, and coexistence with terminal Cat Code processes. The contract must prevent an older app from silently rewriting newer state and must preserve DR-2 fresh-read-under-lock discipline.

This is a decision session, not implementation. Done means the complete format inventory is source-anchored, upgrade and downgrade matrices are explicit, destructive cases fail closed, P5-4/P5-5b/P5-12 can implement without ambiguity, canonical persistence/release maps are updated, docs checks pass, and STATUS is updated.
```

## Original P5-5b — State migrations, upgrade, and rollback implementation (WAIVED)

🧠 **Model: ANY · Difficulty: 9/10 · 🖐 GUI**

```text
Work in /Users/pt/cat-code on branch migration. This is P5-5b. Echo the Model/Difficulty header before starting and read docs/migration/process/GUI-VERIFICATION.md before live checks.

Implement and test the P5-5a compatibility contract for desktop-owned persisted state and the decided desktop entry point for existing engine migrations. Use isolated fixture config homes representing the oldest supported version, current version, corrupt records, interrupted writes, and unknown-newer records. Do not copy or mutate the operator's live state; P5-5c owns simultaneous TUI/desktop behavior.

A successful upgrade must preserve session addresses, engine transcript identity, restorable state, settings ownership, and layout data promised by the contract. A failed migration must leave a recoverable prior copy or fail closed without partial mixed-version state. A supported rollback must behave exactly as P5-5a specifies; unsupported downgrade must be explicit and non-destructive.

Done means fixtures prove each matrix cell, process-level probes cover load-bearing cross-process writes, mutation tests demonstrate the migrations are exercised, packaged upgrade steps are handed to the operator where GUI/system installation is required, all relevant batteries pass, stale format assumptions are swept, and STATUS is updated.
```

## Original P5-6 — Canonical release test matrix and CI gate (WAIVED)

🧠 **Model: ANY · Difficulty: 8/10**

```text
Work in /Users/pt/cat-code on branch migration. This is P5-6. Echo the Model/Difficulty header before starting.

Create one canonical release test matrix and executable gate for the engine, desktop shell, sidecar boundary, renderer, hardening, packaging, and credential-free process probes. Preserve the repository's known-red rules: no bare root bun test, no root typecheck gate, and no raw sidecar typecheck gate. Separate deterministic release blockers, isolated probes, optional credentialed checks, and operator GUI evidence.

The gate must expose skipped, flaky, timed-out, and missing-prerequisite cases rather than folding them into green. Eliminate or quarantine order-dependent module pollution and prove the selected suites are repeatable in the same grouping CI will use. CI configuration is in scope only if it can run without publishing or live credentials; changing shared hosted CI remains a separately authorized action.

Done means a documented command or small command set produces a machine-readable and human-readable release verdict from a clean checkout, repeat runs have stable membership/counts, failures name the owning layer, package tests from P5-1/P5-2 are included, maps/docs are current, and STATUS is updated with measured evidence.
```

## Original P5-7 — Packaged security and privacy audit (narrowed into the new P5-7 job 1)

🧠 **Model: ANY · Difficulty: 9/10 · 🖐 GUI**

```text
Work in /Users/pt/cat-code on branch migration. This is P5-7. Echo the Model/Difficulty header before starting and read docs/migration/process/GUI-VERIFICATION.md before live checks.

Audit and fix the packaged artifact against SECURITY-MINIMUM and the platform packaging threat surface. The review must cover packaged BrowserWindow settings, navigation/window-open policy, CSP and Markdown behavior, preload exports, IPC channel inventory, sidecar inbound validation, resource permissions, protocol/custom-scheme exposure if any, artifact contents, diagnostics/privacy boundaries, and update privileges introduced by P5-4.

Do not widen the renderer's authority to solve packaging convenience. Every finding needs a source-verified exploit/failure scenario and a focused regression or explicit accepted residual. Use synthetic secrets and hostile content fixtures only.

Done means hardening passes against the packaged configuration, source and built-artifact checks agree, no secret/private fixture crosses into renderer or artifact output, unsafe navigation/IPC/update payloads fail closed, operator steps cover only behavior unavailable headlessly, all fixes pass the full affected batteries, and STATUS records a GREEN/YELLOW/RED release-security verdict with residuals.
```

## Original P5-8 — Performance budgets and reproducible benchmarks (WAIVED; tooling retained)

🧠 **Model: ANY · Difficulty: 8/10 · 🖐 GUI**

```text
Work in /Users/pt/cat-code on branch migration. This is P5-8. Echo the Model/Difficulty header before starting and read docs/migration/process/GUI-VERIFICATION.md before live checks.

Define and implement reproducible performance measurements for packaged cold start, renderer-ready time, first usable session, session switch, restore, long transcript interaction, streaming render commits, idle CPU, memory per session/sidecar, and multi-session operation. Reuse current diagnostics and memory-trajectory machinery where it measures the required fact; do not create model-visible logging or feed private transcripts into prompts.

Set numeric release budgets before using them as pass/fail gates. Record hardware/OS context, warm versus cold conditions, fixture shape, sample count, and variance. Measurements that Electron or the DOM cannot provide headlessly must be clearly operator-run, not estimated from unit tests.

Done means benchmark commands use synthetic bounded fixtures, results are machine-readable, thresholds are test-enforced without moving them to fit a bad run, baseline numbers are recorded, regressions identify the owning stage, all spawned processes are reconciled, applicable batteries pass, and STATUS is updated.
```

## Original P5-9 — Soak, resource lifetime, and cleanup (merged into the new P5-7 job 2)

🧠 **Model: ANY · Difficulty: 8/10 · 🖐 GUI**

```text
Work in /Users/pt/cat-code on branch migration. This is P5-9. Echo the Model/Difficulty header before starting and read docs/migration/process/GUI-VERIFICATION.md before live checks.

Build a bounded soak harness around the packaged runtime and P5-8 budgets. Exercise repeated session create/run/park/restore/close, renderer reload, sidecar crash/restart, long streaming, large transcript viewing, worker completion, diagnostics rotation, and application quit/relaunch. Use synthetic workspaces and isolated config homes.

The harness must detect leaked sidecars/helpers, stale sockets/temp directories, unbounded log/cache growth, timers/listeners that grow with iterations, memory slope, and one-session failure harming another. It must own exact PIDs and never use sweep kills. Credentialed model turns are optional and separately authorized; deterministic adapters should cover the lifecycle gate.

Done means a documented duration/iteration run has objective pass/fail thresholds from P5-8, cleanup returns to baseline, failures preserve diagnostics without private content, at least one deliberate leak/regression is caught by a mutation or fixture, operator-only packaged observations are explicit, and STATUS records the measured result.
```

## Original P5-10 — Whole-app accessibility gate (WAIVED)

🧠 **Model: ANY · Difficulty: 8/10 · 🖐 GUI**

```text
Work in /Users/pt/cat-code on branch migration. This is P5-10. Echo the Model/Difficulty header before starting and read docs/migration/process/GUI-VERIFICATION.md before live checks.

Audit and fix the current feature-frozen desktop app as one keyboard and assistive-technology workflow. Cover launch/welcome, session roster and tabs, composer, transcript/tool cards, permissions and AskUserQuestion, dialogs/menus, settings, accounts, tasks/workers, errors, and update UI. Check keyboard-only reachability, visible focus, focus trapping/restoration, semantic names/states, announcement of asynchronous status, contrast, zoom/text scaling, reduced motion, and minimum-window behavior.

Automate structural and keyboard behavior where the existing DOM harness can prove it. Do not claim layout, screen-reader, hover, or native-window behavior from SSR/happy-dom. Do not redesign Phase-4 visuals unless accessibility makes current behavior unusable; record any unavoidable visual adaptation.

Done means automated checks cover stable invariants, exact operator steps cover VoiceOver/native/visual behavior, critical workflows are completable without a pointer, no control depends only on color or hover, failures have owners and regression tests, renderer/build batteries pass, and STATUS records the accessibility verdict and unverified platform limits.
```

## Original P5-11 — Failure recovery and support diagnostics (merged into the new P5-7 job 3)

🧠 **Model: ANY · Difficulty: 8/10 · 🖐 GUI**

```text
Work in /Users/pt/cat-code on branch migration. This is P5-11. Echo the Model/Difficulty header before starting and read docs/migration/process/GUI-VERIFICATION.md before live checks.

Create and execute a release failure matrix for packaged startup, renderer crash/reload, sidecar spawn failure, one-sidecar crash, registry corruption, missing/corrupt transcript, unwritable config directory, interrupted state write, expired authentication, network loss, update failure, diagnostics write failure, and disk-pressure behavior supported by current abstractions.

Each case must end in an honest user state: retry, restart, restore, explicit non-recoverable loss, or safe degradation. No silent fresh session may impersonate restore. Preserve private diagnostic schemas and caps; the support bundle must remain allowlisted and redacted, and raw logs/transcripts/settings must never become model context.

Done means deterministic failure injection covers the matrix where possible, packaged operator steps cover the rest, diagnostics identify the layer and failure code without secrets, recovery does not damage unaffected sessions, stale or misleading copy is corrected, relevant tests/hardening/builds pass, and STATUS records every unautomated or accepted residual.
```

## Original P5-12 — Fresh install, update, and rollback rehearsal (WAIVED)

🧠 **Model: ANY · Difficulty: 8/10 · 🖐 GUI**

```text
Work in /Users/pt/cat-code on branch migration. This is P5-12. Echo the Model/Difficulty header before starting and read docs/migration/process/GUI-VERIFICATION.md before live checks.

Turn the P5-0, P5-1, P5-3, P5-4, and P5-5 contracts into a reproducible release rehearsal using isolated machine state. Cover fresh install and first launch, creation of real persisted desktop state, update to the next version, preservation of sessions/settings/layout/account references without copying credentials into fixtures, supported rollback or explicit downgrade refusal, uninstall/reinstall data posture, and terminal/desktop coexistence.

Automate artifact and state assertions. System installation, live signing/notarization, and real update-feed publication remain operator-owned shared-state actions. Never install over or mutate the operator's active Cat Code application without explicit authorization.

Done means a copy-ready runbook and scripts reproduce every authorized step, artifact hashes/versions are recorded, before/after state assertions follow P5-5a, failures use P5-11 recovery evidence, no orphan processes remain, the rehearsal identifies every external prerequisite, and STATUS distinguishes simulated/local proof from live platform proof.
```

## Original P5-13 — Release-candidate integration gate (WAIVED)

🧠 **Model: ANY · Difficulty: 9/10 · 🖐 GUI**

```text
Work in /Users/pt/cat-code on branch migration. This is P5-13, the Phase-5 gate. Echo the Model/Difficulty header before starting and read docs/migration/process/GUI-VERIFICATION.md before live checks.

Certify one immutable release-candidate artifact against the complete Phase-5 contract. Do not fix unrelated findings inside the gate: a failed condition returns the owning P5 row to active with evidence, then the gate reruns against a newly identified artifact.

The candidate must be reproducibly packaged, carry the correct identity/version, satisfy the signing posture, run without development dependencies, pass the P5-6 release matrix and P5-7 security verdict, meet P5-8 budgets and P5-9 soak thresholds, satisfy P5-10 accessibility acceptance, pass P5-11 recovery cases, and complete the authorized P5-12 install/update/rollback rehearsal. Hash the exact artifact so evidence cannot be assembled from different builds.

Publishing or installing into the operator's live environment requires separate authorization and is not implied by running this gate.

Done means the evidence report names the artifact hash and every command/result, contains no hidden red or unverified required condition, lists external operator-owned actions separately, updates canonical release/build maps, marks P5-13 and the Phase-5 gate accurately in STATUS, and states SHIPPABLE or NOT SHIPPABLE without weakening the contract.
```
