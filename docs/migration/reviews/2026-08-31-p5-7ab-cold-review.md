# P5-7a / P5-7b cold review

**Date:** 2026-08-31
**Verdict:** **RED** — P5-7b does not prove the required real packaged
create/run/close lifecycle. P5-7a is a sound narrow guard but is not yet
verification-complete.

## Contract

The surviving P5-7 backlog requires a packaging-security delta, a current
packaged leak baseline whose cleanup returns to baseline, and explicit
operator steps for anything unavailable headlessly. Its leak job specifically
calls for repeated session create/run/close and renderer reload behavior
(`docs/migration/backlog/phase5.md:240-246`).

The reviewed worktrees were:

- `.worktrees/p5-7a`: package scanner plus P5-7 split bookkeeping;
- `.worktrees/p5-7b`: RAM and renderer-memory measurement scripts.

No code was modified during this review.

## Conformance

| Contract item | Verdict | Evidence |
|---|---|---|
| P5-7a checks a packaged production-preload boundary | implemented | `app/scripts/package-app.ts:261-264` copies exactly `preload.cjs`; `app/scripts/packagedBundleScan.ts:147-151` rejects a bundled debug bridge; the focused synthetic regression covers that condition. |
| P5-7a verifies packaged BrowserWindow, navigation, CSP, and production preload behavior | partial | The existing hardening smoke owns those production-path checks, but P5-7a did not run it. |
| P5-7b resolves the packaged sidecar through the production launch decision | implemented | `app/scripts/ram-probe.ts:221-232` and `ram-fleet.ts:389-400` call `resolveSidecarLaunch`; the resolver's packaged branch selects `Resources/sidecar/cat-code-sidecar` in `app/main/mainDecisions.ts:150-158`. |
| P5-7b proves a real packaged turn during lifecycle measurement | missing | See F1. |
| P5-7b establishes a packaged renderer-reload baseline | missing | See F2. |

## Findings

### F1 — High: P5-7b's asserted turn is a fixture turn, not a real packaged-engine turn

`ram-probe.ts` sets `CATCODE_SIDECAR_PROBE=1` only for `--mode probe`
(`app/scripts/ram-probe.ts:272`) and makes `syntheticTurnCompleted` mandatory
only in that mode (`:436-454`). That flag routes the sidecar through
`createSidecarSessionController({ probe: true })` (`app/sidecar/index.ts:297-303`).
The probe branch returns a `createQueryEngineSessionController` backed by
`createProbeAdapter()` and explicitly has no engine app-state or configured
cwd (`app/sidecar/sessionController.ts:567-601`). Its attach callback submits
`__p1_0_probe__` only to that fixture controller (`app/sidecar/index.ts:476-488`).

In ordinary real-engine mode, `ram-probe.ts` merely opens the socket and
samples memory (`app/scripts/ram-probe.ts:326-397`); it does not submit an
inbound `app.submit` frame and the completion expression is automatically true
because `mode !== 'probe'` (`:436-441`).

A leak or lifecycle defect in the packaged runtime-backed controller, query
execution, provider setup, or post-turn cleanup can therefore pass this probe:
the only measured turn takes the P1 fixture path, while the real path executes
no turn. P5-7b needs a synthetic, credential-free real-engine turn through the
same packaged sidecar route, with its active-turn start and terminal transition
observed before cleanup is measured. Owner: **P5-7b rework**.

### F2 — Medium: no current packaged renderer-reload measurement is demonstrated

`renderer-memory-trajectory.ts` adds `--require-packaged`, but it only checks
that an externally supplied operational log contains `app.start` with
`packaged=true` (`app/scripts/renderer-memory-trajectory.ts:292-316`). It does
not launch the packaged app or exercise a renderer reload itself. No headless
or operator result showing an isolated packaged renderer lifecycle was available
for review.

This is not a reason to invent a new soak harness. The existing script may be
used, but P5-7b must record the bounded run and, if it still needs an operator
launch, provide exact isolated steps and leave that part explicitly unverified
until performed. Owner: **P5-7b rework**.

### F3 — Medium: P5-7a is not yet eligible for a green completion claim

P5-7a's focused package-scan test passed in this review: 19 pass / 0 fail.
The added test is meaningful, and the package path invokes the scanner after
copying the production preload (`app/scripts/package-app.ts:261-289`).

However, its app typecheck could not run because the worktree lacks
`eslint-plugin-jsx-a11y`; ESLint failed before TypeScript began. The mandatory
`bun run --cwd app test:hardening` production-path smoke was also skipped.
The latter launch needs operator authorization because it starts Electron. The
security baseline hard gate cannot be substituted by the P5-7c run: that run
used a different worktree and did not contain P5-7a's package-scan change.

Restore the worktree's declared dependencies, rerun typecheck, and run the
isolated hardening smoke under an explicit per-run GUI authorization before
marking P5-7a complete. Owner: **P5-7a**.

### F4 — Medium: neither P5-7a nor P5-7b has passed the mandatory hardening gate

Both worktrees modify `app/` code or scripts. The desktop quality bar requires
`bun run --cwd app test:hardening` for every such change, but neither P5-7a nor
P5-7b ran it. The P5-7c smoke result cannot stand in for either branch because
it did not include their diffs.

The smoke launches Electron and therefore needs explicit authorization for each
isolated worktree run. Re-run it after F1 is fixed for P5-7b and after the
dependency issue is repaired for P5-7a. Owners: **P5-7a and P5-7b**.

## Verification run directly in this review

```text
p5-7a: bun test app/scripts/packagedBundleScan.test.ts
  19 pass / 0 fail

p5-7a: bun run --cwd app typecheck
  blocked before typecheck: ESLint could not resolve eslint-plugin-jsx-a11y

p5-7a: bun run maps:lint
  passed, with 7 pre-existing advisory warnings

p5-7b: bun test app/scripts/ramScriptsSource.test.ts
  10 pass / 0 fail

p5-7b: bun run --cwd app typecheck
  passed

p5-7b: bun run --cwd app typecheck:sidecar
  passed; 5,569 upstream diagnostics ignored, 0 owned diagnostics

p5-7b: bun run --cwd app package
  passed; packaged app and standalone sidecar built, stowaway scan clean
```

An attempted direct packaged P5-7b probe was denied before launch because the
permission system classified it as a GUI-capable packaged-app run. It was not
retried. The source-level F1 defect already prevents accepting that task.

All three P5-7 worktree diffs were whitespace-clean at review time.

## Disposition

Do not mark P5-7, P5-7a, or P5-7b complete. Rework P5-7b around a real packaged
runtime-backed turn, capture the renderer baseline or record exact operator
steps, restore P5-7a's test dependency, and run P5-7a's hardening gate under
explicit authorization. Run P5-7b's hardening gate after F1 is fixed. P5-7c is
outside this review; its hardening smoke was run separately and passed 19/19.
