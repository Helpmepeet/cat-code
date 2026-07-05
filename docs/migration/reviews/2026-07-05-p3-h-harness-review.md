# P3-H review (GUI-verification dev harness, commit `5b7da55`)

**Status: DONE 2026-07-05.** Per-commit review of `git show 5b7da55` ("Add P3-H GUI
verification harness"): `app/main/devHarness.ts` + main wiring, dev-only debug export
(preload/renderer/shared), dual preload bundles, `harness-demo.ts` + driver, hardening
additions, tests, and the design/proposal/process docs. Headless; every claim verified in
source, two claims verified empirically (see SF-1).

**One-line recommendation: accept as landed — nothing threatens the security baseline or
blocks P3-6.** One confirmed dev-script bug (SF-1), one weakened HC1 test pin (SF-2), and
two LOWs; all four are contained and fixable in minutes whenever an operator schedules them.
**No fixes were applied** (operator ruling 2026-07-05: review is informational, tree
untouched).

## Findings NOT landed (operator decides)

### SF-1 (SHOULD-FIX) — harness-demo cleanup is dead code; orphan Vite on timeout
Every path through `app/scripts/harness-demo.ts` ends in `process.exit(...)` inside the
`try` (success at `harness-demo.ts:76`), and `process.exit` does **not** unwind `finally`
— verified empirically in Bun (a `try { process.exit(0) } finally { … }` probe never runs
the finally). So the cleanup at `harness-demo.ts:77-81` (`rmSync` of the driver bundle,
scratch cwd, config home) never runs except on the throw paths. **Proven by residue:** 8+
leaked `catcode-harness-cwd-*` / `catcode-harness-config-*` dirs from the P3-H session's
own runs were found in `$TMPDIR` during this review. On success runs the built
`app/scripts/harness-demo-driver.cjs` is also left in the working tree (see L-3).
Related, same file: on the throw paths (Vite or Electron timeout) the `finally` DOES run,
but `vite.kill()` (`harness-demo.ts:70`) sits after the awaits and is never reached — an
orphaned Vite keeps holding port 5173, and because Vite auto-increments its port while the
demo hardcodes 5173, the NEXT demo run silently drives the leftover server's renderer.
**Proposed:** hoist `vite.kill()` + the three `rmSync`s into one cleanup function called
before every exit (or set `process.exitCode` and fall through instead of `process.exit`).

### SF-2 (SHOULD-FIX) — HC1 pick-body test pin quietly weakened
`app/main/mainSource.test.ts:182` changed its slice anchor from
`'ipcMain.handle(CH_HOST_PICK_DIR'` to bare `'CH_HOST_PICK_DIR'`, whose FIRST occurrence
is now the constant declaration at `main.ts:84`. The "pick handler body" slice therefore
spans ~400 lines of unrelated code (window creation, security baseline, all of
`registerIpcHandlers`), so `toContain('return mintCwdToken(chosen.realpath)')` no longer
proves the token mint happens *inside the pick handler* — and this is one of the HC1
security pins. The handler merely became multiline; the correct anchor is
`'ipcMain.handle(\n    CH_HOST_PICK_DIR'` — the same idiom the test already uses for
`CH_HOST_CREATE` one line below (`mainSource.test.ts:183`).

### L-3 (LOW) — new build artifacts not gitignored
`app/.gitignore` covers `preload/preload.cjs` but not the new `preload/preload.dev.cjs`
(emitted by every dev launch AND by `preloadBundle.test.ts`, i.e. by `bun test app/`), nor
`scripts/harness-demo-driver.cjs` (which SF-1 leaves behind on success runs). Both surface
as untracked noise with accidental-commit risk. Two lines in `app/.gitignore`.

### L-4 (LOW) — silent design deviation: no main-side debounce on export writes
The design doc (§3, §8) specifies the export write "debounced (250 ms)" with the debounce
living in `devHarness.ts`. As landed, `writeDebugStateExport` (`main.ts:557`) does a
synchronous `mkdir+open+write+fsync+rename` on the Electron main thread on EVERY HostEvent
(`main.ts:321`), every validated renderer push (`main.ts:553`), the readiness latch
(`main.ts:171`), and primary-create (`main.ts:784`). Practical impact is small — HostEvents
are row-change-frequency and the whole path is double-gated behind `CATCODE_DEBUG_STATE=1`
— but the P3-H prompt required deviations to be stated in the report, and the report
doesn't mention this one. Either add the debounce or record the deviation; don't leave it
silent.

## Notes (no action required)

- **Channel-name literal duplication** — preload hardcodes `'catcode:debug:shell-state'`
  (`preload.ts`, inside the `__CATCODE_DEV_HARNESS__` block; justified — importing
  `DEBUG_SHELL_STATE_CHANNEL` would defeat the dead-code strip), but nothing pins it equal
  to the shared constant main listens on (`shared/debugState.ts`). A rename on either side
  makes sends land on an unregistered channel — dropped silently, by design. A one-line
  equality test would close it.
- **Renderer push edge cases** (`App.tsx` debug effect) — the 250 ms trailing timer resets
  on every shell/connection/permission change, so sustained sub-250ms churn starves the
  push (renderer half goes stale; detectable only via `rendererStateAt`, which
  GUI-VERIFICATION.md does document). Also `sendGuard.assertAllowed` can throw (128 KiB /
  120-per-second caps, shared with the real senders) inside the `setTimeout` callback with
  no catch — an uncaught dev-only exception. Both unlikely in practice.
- **hardening-smoke export-path fallback** — `hardening-smoke.ts` builds the no-export
  assertion path from `process.env.CLAUDE_CONFIG_DIR ?? ''`, yielding a RELATIVE
  `desktop/debug/state.json` when the env is unset (assertion trivially passes). Only
  reachable when the smoke runs without its runner — `run-hardening-smoke.ts` now always
  sets the env. Same file: the runner `mkdtemp`s its config home before the
  electron-missing early exit — tiny leak on that path.
- **Build inside the test suite** — `preloadBundle.test.ts` spawns a full
  `build-electron.ts` run (2 preload bundles + main) inside `bun test app/`, and
  `harness-demo.ts` builds again; adds seconds to every suite run and mutates working-tree
  build artifacts. Acceptable; it IS the enforcement of the strip guarantee.
- **Allowlist `split(':')`** — a path containing a colon can't be expressed. Dev-only,
  matches the design; fine.
- **Deferred (not a finding today)** — no packaging config exists yet, but when one lands,
  `preload.dev.cjs` must be excluded from the app bundle: the strip test proves
  `preload.cjs` is clean, not that the dev bundle doesn't ship.

## What was hunted and came back clean

- **Gating** — frozen `DevHarnessConfig` resolved once at startup; unconditionally
  `disabled`/false when `app.isPackaged` regardless of env; env never re-read per call.
- **HC1/T8** — the bypass is main-side only; the resolved dir still runs `validateCwd` +
  the one-time `mintCwdToken`; `CreateSessionInput` still cannot express a path; the
  renderer surface is unchanged.
- **D2 hint hygiene** — `activeSessionId` treated as untrusted (`unknown` → UUID shape
  check → membership in `host.listSessions()`, the HC2 idiom); fallback is
  most-recent-attached non-restorable cwd, then `undefined`.
- **`parseDebugSnapshot` strictness** — exact-keys at every level, version pin, bounded
  arrays/strings, enum-checked tone/kind; malformed pushes dropped with a loud log, never
  partially written.
- **Fail-closed picker** — broken allowlist ⇒ null picks + loud log, dialog unreachable;
  vanished entry ⇒ null WITHOUT advancing the cursor (matches the PT-6 ruling; tested).
- **Readiness latch** — exactly one line in either event order (tested both orders).
- **Atomic writer** — 0600 file / 0700 dir, temp+fsync+rename; tested.
- **Registry stays read-only** — the export uses the PRE-EXISTING copy-getter
  `registry.ts:333 get sessions()`; the design's "add a read-only accessor" turned out
  unnecessary (it already existed) — not a deviation, nothing new touches registry writes.
- **Removed-behavior audit** — `wireHostEvents`' null-window behavior preserved
  (`if (!contents) return` → `if (contents) …send`); the primary-session create still runs
  strictly after the launch sweep, now with the `initialCwd ?? process.cwd()` root and the
  invalid-initial-cwd fail-loud-empty branch per the §11 ruling.
- **Preload strip** — dual bundles via `__CATCODE_DEV_HARNESS__` define; bundle-level test
  asserts packaged `preload.cjs` contains no `catcode:debug:` string while
  `preload.dev.cjs` does; `scripts/dev.ts` builds via `build-electron.ts`, so the dev flow
  always has `preload.dev.cjs` before main selects it.

## Verification

Review was source-reading over the full commit diff plus targeted repo greps; no test
suites were re-run (the P3-H session's own results — 365 pass, both tscs, 19/19 hardening,
demo pass — were not re-executed). Two empirical probes were run for SF-1: the Bun
`process.exit`-skips-`finally` check, and the `$TMPDIR` residue listing that proves the
leak occurred on the session's real runs.

---

## Addendum (2026-07-05) — discoverability review: will future sessions find and use it?

Second pass, different question: the harness is a PROCESS artifact, so its value is
`(code works) × (the next cold session actually reaches the doc)`. Traced every routing
path a future session could arrive by. **Verdict: P3-6/P3-7 workers will find it; P3-8,
everything the orchestrator generates later (Phase 4/5 — the claimed 15–20 GUI runs that
justified building this), and every Codex GUI verifier currently rely on memory and
hand-written spawn prompts, not docs.**

### Routing audit, path by path

| Who spawns next | Route to the harness | Holds? |
|---|---|---|
| P3-6 / P3-7 worker | backlog prompt pointer (`phase3.md:809`, `:863`) → GUI-VERIFICATION.md | ✅ works — though the pointer's wording sells only the aria-label rule, not "plan your GUI verification around the harness"; the recipe is one hop away and the doc is short, acceptable |
| P3-8 gate worker/operator | **no pointer.** The prompt names the bypass only negatively ("not the P3-H allowlist bypass", `phase3.md:969`) | ❌ the gate is the row that needs it most (multi-session setup, readiness waits, pid forensics for the nonce/PID assertions) and the only mention assumes the reader already knows what P3-H is |
| Phase-4/5 backlog generation (orchestrator, Scenario 2) | nothing. PROGRAM-PLAN §8 unpatched, `.claude/rules/migration.md` unpatched, no standing "GUI rows get the GUI-VERIFICATION.md pointer" rule anywhere the orchestrator reads at generation time | ❌ honesty rule 3 SAYS "standing convention for … Phase-4 prompts" — but it lives *inside* the doc it's supposed to propagate; circular. The convention survives only if the orchestrator session happens to remember |
| Cold reader via folder map | `docs/migration/README.md:22` lists `process/` as "How-to scaffolding: `HANDOFF`, `REVIEW-PROMPT`" — GUI-VERIFICATION not named | ❌ stale map row |
| Cold agent at the running app | flags log loudly only when SET; no hint exists that the flags exist if you don't already know | — acceptable for a dev harness, but it means discoverability is 100 % doc-routed, which raises the stakes on the rows above |
| Orchestrator via STATUS | P3-H row says "…and GUI verification docs/backlog riders" — no path | ⚠️ findable with effort |

### The Codex path (the agent that actually drives the GUI)

The GUI verifier is usually a spawned Codex agent, and its discovery surface is
different from a Claude session's — checked separately:

- **Ambient discovery is zero.** Codex loads `AGENTS.md`: the global
  `~/.codex/AGENTS.md` is empty, and the repo `AGENTS.md` says only "See `CLAUDE.md`"
  — which never mentions `docs/migration/` or GUI verification at all. The migration
  rules that DO route Claude sessions live in `.claude/rules/migration.md`, a
  Claude-harness mechanism Codex never loads. Same for the cua-driver skill
  (Claude-side skill dir). **A cold Codex verifier in this repo has no path to the
  harness other than its spawn prompt.**
- **So the chain is two-hop and both hops are prompts:** a Claude session (worker or
  orchestrator) must (1) itself reach GUI-VERIFICATION.md — the gaps in the table
  above — and then (2) transfer the harness knowledge into the Codex spawn prompt.
  Hop 2 has a documented failure mode (the 2026-06-11 prompt-writing analysis:
  handoff prompts written as summaries, not audience-modeled transfers). Nothing in
  the process docs standardizes what a GUI-verifier spawn prompt must contain.
- **GUI-VERIFICATION.md is addressed to that verifier but doesn't speak its
  language:** no mention of cua-driver, no `list_apps` discovery hint, and (per the
  content audit below) not even the "Cat Code Dev" app name — the one string the
  verifier needs first.

### Content audit — is the doc sufficient once reached?

Read as a cold verifier agent, GUI-VERIFICATION.md has the launch recipe, readiness
line, export path/schema skeleton, freshness rule, and honesty rules. Four gaps:

- **D4 is undocumented — the app name.** The doc never says the dev app appears as
  **"Cat Code Dev"** in AX/`list_apps`/window title. That was D4's entire purpose
  (deterministic discovery); the one consumer the feature was built for isn't told.
- **`<claude-config-home>` unresolved.** The export path is given relative to a term the
  doc never defines (`CLAUDE_CONFIG_DIR` else `~/.cat-code` — `registry.ts:163`). A cold
  agent must grep source to find its own export file.
- **`sessions[]` fields unlisted.** The schema example shows `"sessions": []` — the doc
  never says rows carry `enginePid`/`socketPath`/`shutdown`, which is exactly the
  session↔pid-correlation payoff the proposal's §1 pain list asked for.
- **Honesty rule 4 was pasted, not executed.** The rule was an instruction to the doc
  author ("note in the GUI-test docs that registry.json already maps appSessionId ↔
  enginePid/cwd/socketPath…"); the doc quotes the instruction verbatim instead of BEING
  the note — no registry.json path, no field list.

### Proposed fixes (all cheap, docs-only; operator decides)

1. GUI-VERIFICATION.md: add "the dev app presents as **Cat Code Dev**"; resolve
   `<claude-config-home>`; list the `sessions[]` advisory fields; replace pasted rule 4
   with the actual registry.json note (path + fields).
2. `backlog/phase3.md` P3-8: add the same read-first pointer P3-6/P3-7 got (the
   real-picker rider already there is the counterweight, not a substitute).
3. One standing line where backlog GENERATION reads (PROGRAM-PLAN §8 or the orchestrator
   rules): every 🖐 GUI row's prompt includes the GUI-VERIFICATION.md pointer — closes
   the Phase-4/5 circularity.
4. `docs/migration/README.md:22`: name GUI-VERIFICATION in the `process/` row.
5. Repo `AGENTS.md`: one line — "Desktop-app GUI verification: see
   `docs/migration/process/GUI-VERIFICATION.md`" — the only durable route for Codex
   verifiers, who load AGENTS.md ambiently and can see none of the Claude-side
   rules/skills.
6. GUI-VERIFICATION.md: add a short "for the driving agent" note (app presents as
   Cat Code Dev; drive via cua-driver/AX; export cross-checks, AX observes) so the
   doc can be pasted into a Codex verifier spawn prompt as-is and be sufficient.
