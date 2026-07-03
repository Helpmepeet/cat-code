# Phase-1 build and test-evidence review — 2026-07-03

**Scope:** independent review of the build and test evidence behind Phase 1 at
`f5ab1e6` on branch `migration`. This is not a security review or adversarial
test. Reviewed against `STATUS.md` P1-0…P1-4, `PROGRAM-PLAN.md`'s Phase-1 gate,
the Phase-0 and direction reviews, the desktop build configuration, and all 19
desktop test files. No app code or plan/status document was changed; this
review is the only output.

## 1. Workstream verdict

**Phase 1 honestly cleared its walking-skeleton gate. It did not clear on
overstated build or test evidence.** The five recorded verification commands
match their claims exactly, and the historical 25-test and 107-test counts in
P1-0/P1-3 are consistent with the suite's growth to 122 tests rather than
inflated current totals.

The evidence has the right two-layer shape for this thin gate:

- Headless tests prove framing, a real sidecar process and Unix socket, boundary
  validation, reducer/projector behavior, static component rendering, and pure
  main-process policy logic.
- The credentialed engine behaviors that cannot be reproduced by `bun test`
  are explicitly labeled as operator GUI evidence in P1-2/P1-3/P1-4: a real
  turn, real tool availability and rendering, and a real permission pause and
  resume.

Two **MEDIUM** gaps are understated but do not invalidate the completed gate:

1. The sidecar—the process containing the engine boundary—has no effective
   typecheck gate. Its only config reports 5,642 errors, so new sidecar errors
   disappear into a permanently red result.
2. The P1-3 fix that changed the normal model path from `tools: []` to
   `getTools(...)` has no regression assertion. All 122 tests can pass if the
   real model becomes text-only again.

**Phase 2 may start on the current evidence.** This review does not block it.
It reshapes the sequence slightly: P2-4 should not begin modifying the sidecar
permission boundary without either a scoped/baselined sidecar typecheck or an
explicit acceptance that the work proceeds with no static safety net. P2-0 or
P2-4 should also pin the normal-path tool list before relying on a real
multi-tool transcript.

## 2. Command results

| Command | Pass/fail | Claimed | Actual | Notes |
|---|---|---|---|---|
| `bun test app/` (repo root) | **PASS** | Latest STATUS total: 122 pass; P1-0's 25 and P1-3's 107 are historical | **122 pass / 0 fail, 295 `expect()` calls, 19 files** | Re-run during this review; exact match. |
| `bunx tsc --noEmit -p app/tsconfig.json` | **PASS** | Desktop shell graph typechecks | **Exit 0** | Covers main, preload, supervisor, shared, renderer, and scripts. `sidecar/**` is deliberately excluded and delegated to its own config (`app/tsconfig.json:21-30`). |
| `bun run --cwd app renderer:build` | **PASS** | Renderer builds; Tailwind import raised generated CSS from roughly 1 kB to 7 kB | **Vite 7.3.2; 197 modules; CSS 8.25 kB** | Consistent with the P1-3 claim; decimal/binary display accounts for the wording difference. |
| `bun run --cwd app test:hardening` | **PASS** | Real Electron hardening smoke | **9/9 PASS** | Exercises a real Electron renderer; Electron absence exits 3 rather than skipping (`app/scripts/run-hardening-smoke.ts:21-25`). |
| `bunx tsc --noEmit -p app/sidecar/tsconfig.json` | **FAIL, as disclosed** | Pre-existing red strict overlay, approximately 5.7k errors | **5,642 errors** | Exactly 2 are in `app/sidecar/` (`MACRO`, `initializeRuntime.ts:12-13`); the other 5,640 are the imported engine graph under `strict: true`. |
| `bun run --cwd app test` | **FAIL** | No STATUS claim; diagnostic requested by this review | **Exit 1: `app/` filter matched no tests** | `app/package.json:14` runs `bun test app/` from the app cwd, which resolves as `app/app/`. The proven command is the repo-root `bun test app/`. |

The hardening, renderer-build, app-typecheck, and sidecar-typecheck results are
the recorded 2026-07-03 results supplied for this continuation and were
cross-checked against their owning scripts/configuration. The root desktop
suite and the package-path diagnostic were run again in this review.

## 3. P1 claim cross-check

| Row | Assessment | Evidence boundary |
|---|---|---|
| **P1-0** | **Accurate, with a test-scope nuance.** Length-prefixed transport and intact structured `tool_use` are tested. | `roundtrip.probe.test.ts:85-124` uses a real Bun sidecar, supervisor, and Unix socket but a hand-injected event; it reaches the supervisor, not Electron main. The recorded Electron smoke supplies the main hop. The phrase is supportable only by those two pieces together. |
| **P1-1** | **Accurate.** Normal startup constructs the real runtime-backed controller, produces canonical `app.ready`, and the renderer accepts only `kind: "ready"` plus payload `type: "app.ready"`. | `roundtrip.probe.test.ts:51-83`, `connectionState.ts:3-14`, `connectionState.test.ts:19-33`, and `rawMessageLog.ts:25-31`. |
| **P1-2** | **Accurate as operator evidence, not automated evidence.** | Tests prove submit/event transport pieces and runtime bootstrap; no test performs a credentialed engine turn. STATUS explicitly describes the observed GUI run. |
| **P1-3** | **Accurate, with one missing regression lock.** The projector and real component render text/tool cards, Tailwind builds, and the live run proved the normal model emitted tools. | `transcriptProjector.test.ts:7-45` and `TranscriptView.test.tsx:5-39` use fixtures. `sessionController.ts:37-60` contains the real `getTools()` fix, but its test does not assert it (finding 2). |
| **P1-4** | **Accurate.** The live permission round-trip is operator evidence; boundary behavior remains genuinely tested. | T6 rewrite rejection/echo acceptance is at `sidecarServer.test.ts:196-255`; empty-input handling at `:257-288`; T6b rejection/backstop at `:290-379`. Permission renderer state and response construction are separately unit-tested. |

## 4. Findings

### 1. CONFIRMED · MEDIUM — The sidecar has no effective typecheck gate

- **Anchors/evidence:** `app/tsconfig.json:21-30` excludes the sidecar;
  `app/sidecar/tsconfig.json:3-13` extends the root graph, turns on strict mode,
  and overrides `include`; root `tsconfig.json:19,23` has `strict: false` and is
  where `env.d.ts` normally enters the graph. The sidecar command reports 5,642
  errors. `app/scripts/` contains build/dev/smoke scripts but no baseline or
  error-count-diff check.
- **What is understated:** STATUS accurately discloses the red check, but a
  permanently red command is not a practical gate. A new error in
  `sidecarServer.ts` becomes error 5,643. The simultaneously green Bun suite
  demonstrates that runtime test transpilation does not substitute for this
  static check.
- **Concrete Phase-2 failure scenario:** P2-4 adds C2/C3 permission frames and
  changes `sidecarServer.ts`; an upstream permission type widens or a response
  field is mishandled. Fixture-covered paths remain green while the only
  typecheck still fails with thousands of unrelated diagnostics.
- **Phase-2 impact:** establish a scoped sidecar check, an accepted error
  baseline/diff, or explicitly accept the missing static net before P2-4.
  Deferring all ownership to Phase-5 CI is too late for the boundary Phase 2
  will edit.

### 2. CONFIRMED · MEDIUM — The normal-path tool wiring has no regression test

- **Anchors/evidence:** `app/sidecar/sessionController.ts:37-60` derives tools
  with `getTools(appStateStore.getState().toolPermissionContext)`.
  `sessionController.test.ts:8-16` checks only controller construction and
  initial state. `roundtrip.probe.test.ts:85-124` injects a fixture under
  `CATCODE_SIDECAR_PROBE=1`; it bypasses normal model tool configuration.
- **Concrete Phase-2 failure scenario:** a setup refactor restores `tools: []`
  or derives tools from a different permission context. All 122 desktop tests,
  including the injected `tool_use` round-trip, stay green while live turns
  become text-only.
- **Phase-2 impact:** P2-0 or P2-4 should assert at the normal session-config
  seam that model-visible tools are non-empty and derived from the same context
  the runtime enforces. This locks an already observed P1 defect rather than
  expanding scope.

### 3. CONFIRMED · LOW — The package-local test script is broken

- **Anchors/evidence:** `app/package.json:14` defines
  `"test": "bun test app/"`. From the package cwd,
  `bun run --cwd app test` exits 1 because the `app/` filter matches no files.
  The repo-root `bun test app/` passes 122/0.
- **Concrete Phase-2 failure scenario:** a P2 worker or future CI job uses the
  conventional package script and gets a false red result, then either bypasses
  the script or mistakenly reports that the suite is unavailable.
- **Phase-2 impact:** fix the path when the next desktop test work lands. This
  is loud and does not create a false green, so it does not block Phase 2.

### 4. CONFIRMED · LOW — A real-socket test title promises a rejection it does not perform

- **Anchors/evidence:** `app/sidecar/roundtrip.probe.test.ts:126-147` is titled
  “a forged sessionId frame is rejected,” but sends a valid ping and checks its
  pong; its own comment describes the happy path. The actual rejection is
  covered at unit level in `sidecarServer.test.ts:134-141`.
- **Concrete Phase-2 failure scenario:** a later review credits the real socket
  path with mis-addressed-frame coverage and removes or weakens the only unit
  assertion under the belief that redundant integration coverage exists.
- **Phase-2 impact:** cosmetic cleanup only: rename it to its actual liveness
  behavior or send a genuinely forged raw frame.

### 5. CONFIRMED · LOW — `mainSource.test.ts` can pass vacuously

- **Anchors/evidence:** `app/main/mainSource.test.ts:4-17` uses two unchecked
  `indexOf` results to slice source text, then asserts only that the slice lacks
  `CATCODE_SIDECAR_PROBE`. If the opening function is renamed, `indexOf`
  returns `-1`, the slice is empty, and the negative assertion passes. A missing
  closing anchor instead silently broadens the inspected region.
- **Concrete Phase-2 failure scenario:** main startup is refactored and the
  opening function renamed while probe opt-in is accidentally added to the new
  supervisor factory. The test remains green because it examines `""`.
- **Phase-2 impact:** assert both anchors are found before slicing, or extract
  supervisor options into a pure function. This does not undermine the current
  source, which was read directly and does not enable the probe.

### 6. CONFIRMED · LOW — Root ESLint silently ignores the desktop app

- **Anchors/evidence:** `eslint.config.js:52-55` matches only
  `src/**/*.{ts,tsx}`. The root lint script (`package.json:18`) supplies changed
  `app/**` files from `main...HEAD`, but
  `bunx eslint app/shared/framing.ts` reports “File ignored because no matching
  configuration was supplied” and exits 0. The current diff expansion includes
  54 app TypeScript files.
- **Concrete Phase-2 failure scenario:** an app-only lint defect enters during
  projector or permission work; `build:dev:full` reports a clean lint stage
  because every desktop file was accepted as an ignored input.
- **Phase-2 impact:** no gate change—the STATUS P1-0 disclosure is accurate and
  strict app typechecking plus tests cover higher-value failures. Keep desktop
  ESLint coverage owned by Phase-5 CI.

### 7. CONFIRMED · LOW — The type snapshot is current, but drift remains unenforced

- **Anchors/evidence:** `app/shared/engine-types.snapshot.d.ts:1-15` pins the
  canonical sources at `234da9e`. A diff from that pin to `f5ab1e6` over those
  sources shows one relevant change:
  `AppReadyPayload.type = "app.ready"` in
  `src/web/appSessionProtocol.ts:157-165`; the snapshot carries it at
  `engine-types.snapshot.d.ts:129-136`. No app script checks snapshot drift.
- **Concrete Phase-2 failure scenario:** the canonical `SDKMessage` or session
  event union changes while P2-0 builds its “exhaustive” projector against the
  stale declaration. App typecheck stays green while the new runtime variant
  falls through.
- **Phase-2 impact:** P2-0 should add an automated canonical-source versus
  snapshot drift check before treating its exhaustive fixture as authoritative.
  Current snapshot truth is not a blocker; its future maintenance is.

## 5. Carry-forward

| Item | Reason | Suggested owner | Source |
|---|---|---|---|
| Create a usable sidecar typecheck (scoped config, baseline/diff, or explicit accepted gap) | P2-4 edits a boundary currently hidden in 5,642 diagnostics | **P2-4**, before boundary changes | Finding 1 |
| Assert non-empty normal-path tools from the enforced permission context | Prevent recurrence of the live `tools: []` failure while probe tests remain green | **P2-0 or P2-4** | Finding 2 |
| Correct the app package test script | Conventional package test command currently false-reds | Next desktop test owner; P2-0 is a natural touchpoint | Finding 3 |
| Rename or repair the forged-session integration test | Test inventory currently overstates real-socket rejection coverage | Cosmetic cleanup | Finding 4 |
| Make the source-grep test assert its anchors | Prevent a vacuous negative assertion after refactor | Next Electron-main test touch | Finding 5 |
| Add `app/**` ESLint coverage | Root lint passes while explicitly ignoring desktop files | **Phase-5 CI** | Finding 6 |
| Automate engine-type snapshot drift detection | P2-0 exhaustiveness depends on the snapshot remaining true | **P2-0** | Finding 7 |

## 6. Test integrity notes

### What the tests genuinely prove

- **Transport framing:** `framing.test.ts` covers split/coalesced frames,
  malformed JSON, and declared-length rejection. The round-trip probe spawns a
  real Bun sidecar through the real supervisor over a real Unix socket.
- **Boundary validation:** `sidecarServer.test.ts` contains 28 behavioral tests
  using real `AppSessionController` instances and in-memory sockets. The turn
  adapters are fixtures, but pending-permission state and boundary response
  handling are real. T4/T5a/T6/T6b/T7, strict-key checks, C1 selection, secret
  scanning, and serialization behavior are substantive rather than snapshots.
- **Runtime bootstrap:** `initializeRuntime.test.ts` spawns a real Bun child,
  runs engine `init()`, reads config, and verifies dev `MACRO` initialization.
- **Pure main-process logic:** attachment/replay tests exercise buffering,
  StrictMode double readiness, reload, cap, and per-session retention.
  Navigation tests exercise the actual extracted policy. These are meaningful
  pure tests, not Electron mocks.
- **Renderer reduction and rendering:** state/projector tests exercise ordered
  raw messages, the two ready discriminants, permission queue behavior,
  echo-only allow construction, and text/`tool_use` projection.
  `TranscriptView.test.tsx`, `PermissionPrompt.test.tsx`, and `App.test.tsx`
  render real React components to static markup.

### What they do not prove

- No automated test performs a live credentialed engine turn or proves that the
  normal model receives tools. The `tool_use` subprocess probe uses a
  hand-injected fixture. P1-2/P1-3/P1-4 therefore rest, appropriately and
  explicitly, on the recorded live operator runs for engine integration.
- Static renderer rendering does not mount `App` in a DOM or execute its
  effects. It does not exercise the preload subscription, submit callback,
  keyboard listener, permission button callbacks, or full state-to-view wiring.
- The real-Electron hardening harness proves Electron runtime properties and
  exact preload exposure, but it re-declares the security window/CSP setup. It
  does not execute production `main.ts`. Main wiring beyond the extracted pure
  policies is covered only by source reading/source-grep and the recorded GUI
  smoke.
- The P1-0 headless `tool_use` probe proves the sidecar-to-supervisor socket
  path. The main-to-renderer hop is supplied by the separate Electron smoke,
  not by `bun test app/`.

## 7. Phase-2 decision

- **Blocks Phase 2:** **No.**
- **Reshapes Phase 2:** **Yes, slightly.** Treat a usable sidecar typecheck (or
  explicit acceptance of its absence) as a P2-4 entry condition, and add the
  normal tool-list regression assertion before relying on the Phase-2
  multi-tool gate.
- **Can Phase 2 start now:** **Yes.** P2-0 can begin immediately on the current
  evidence, with snapshot-drift automation and the tool-wiring assertion in
  its early test work.
