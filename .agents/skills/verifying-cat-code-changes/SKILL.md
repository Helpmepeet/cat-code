---
name: verifying-cat-code-changes
description: "Use before claiming progress or completion on Cat Code code, docs, or config changes to select checks and report evidence. Not for other repositories or choosing affected docs/registries; use checking-cat-code-change-impact."
---

# Verifying Cat Code Changes

## Overview

"Done" in cat-code means: the correct battery for every touched area ran, and
the actual outcomes are pasted in the report. The battery is area-dependent —
running the wrong one produces false confidence (root build proves nothing
about `app/`) or false alarms (raw sidecar tsc and root tsc are expected-red).

For a UI surface with a prototype counterpart, a green battery is *necessary but
not sufficient*: fidelity is a separate, artifact-backed acceptance tier (see
FIDELITY under Step 2, and the SURFACE ACCEPTANCE verdict in Step 4). Green
tests have repeatedly coexisted with visible prototype drift — the suite asserts
Tailwind class *names*, so a token resolving to the wrong hex passes every test.

## Step 1 — Classify what you touched

```bash
git -C /Users/pt/cat-code status --short    # or git diff --name-only
```

Map each changed path: `src/**` or `scripts/**` → ENGINE · `app/**` → DESKTOP ·
only `docs/**`/`*.md` → DOCS. A change can hit several areas;
run every matching battery from the repo root. Anything unmatched (root
configs like `package.json`/`tsconfig.json`/`eslint.config.js`,
`renderer-theme/`, `.claude/`, skills): treat as ENGINE if it can affect the
build (`build:dev:full` + `./cli-dev --version` must print), otherwise state
explicitly which battery you chose and why — never conclude "no battery
applies" and claim done unverified.

## Step 2 — Run the battery

### ENGINE (`src/`, `scripts/`)

```bash
bun run build:dev:full                      # the gate: lint + ./cli-dev + version print
bun test <focused test paths near the changed files>
```

- NEVER bare `bun test` on the whole repo — Codex account suites only pass
  file-isolated. NEVER `bun run build` / `./cli` unless the user asked.
- Pick test paths from colocated `*.test.ts(x)` plus
  `docs/maps/build-release-testing.md` §Test Routing.
- **Root `bun run typecheck` is KNOWN-RED** (~1,862 pre-existing errors,
  2026-07-07). Never cite it as a gate; if types matter to the change, diff the
  error output before vs after — zero NEW errors is the bar.
- **Lint is not evidence**: it only covers files changed vs `main...HEAD`, and
  the config enables zero rules (all custom rules are
  no-op stubs) — a lint pass is a parse check. Tests and builds are the
  evidence, not lint.
- Shared-type changes: also run the test suites of downstream consumers you
  touched indirectly (lint/typecheck will not catch them).

### DESKTOP (`app/`)

```bash
bun test app/
bun run --cwd app typecheck
bun run --cwd app typecheck:sidecar
bun run --cwd app test:hardening            # launches Electron — see note below
bun run --cwd app renderer:build            # only if renderer build inputs changed
```

- **For dispatched migration sessions, the current phase backlog's
  Standing-rules verification bar overrides this list wherever they disagree.**
- `test:hardening` launches a real Electron window on the operator's machine.
  Run it when your change touches the boundary/preload/security surface or the
  backlog requires it; if the operator hasn't authorized app launches this
  session, list it under "Not run" with the exact command instead of running it.

- `typecheck:sidecar` pass bar: the wrapper prints
  "Scoped sidecar typecheck passed (N upstream diagnostics ignored)". The
  ~5.5k upstream diagnostics are expected; any diagnostic in owned
  `app/sidecar`/`app/shared` files fails the run and is yours.
- Baseline drift: as of 2026-07-07 the suite is 485 pass / 0 fail and
  hardening is 19 checks. Counts GROW over time — compare against the evidence
  numbers in the newest ✅ session row of `docs/migration/STATUS.md`, and treat
  a pass-count DROP or any new owned diagnostic as a regression.
- If you touched `SDKMessage` union handling: re-fire both exhaustiveness
  tripwires (temporarily delete a projector case → expect a `never`
  assignment error; delete a fixture key in `sdkMessageFixtures.ts` → expect a
  mapped-type error; restore byte-identical).

### FIDELITY (prototype-affecting renderer changes) — required, not optional

Applies when your change touches an `app/renderer/src/` surface that has a
prototype counterpart in `~/catcode_prototype/cat-app/` (the
`cat-code-migration-session` skill flags which surfaces carry this). For those,
the DESKTOP battery proves the code runs — it does NOT prove the surface *reads
as* the prototype, and green batteries have repeatedly shipped alongside visible
drift.

The forcing function is a **state-by-state comparison artifact**, not one
convenient screenshot. Enumerate the states the surface actually renders (e.g.
empty / mid-turn / completed-turn / disconnected / crashed): a surface can match
in one state and be blank or wrong in another (the mount-gate class of miss — an
element reviewed "0 High" while never rendering in the operator's state). For
each state, compare prototype vs actual and fill the evidence block:

```text
FIDELITY
- Surfaces touched:      <surface(s), by name>
- States compared:       <each state enumerated>
- Prototype anchors:     <prototype file:line per surface — e.g. Surfaces.jsx:481>
- Comparison artifacts:  <per state: harness output, or an operator-captured
                          prototype|actual screenshot PAIR — never a single image>
- Open mismatches:       <every prototype-vs-actual gap still present>
- Operator-approved deviations:  <only deviations the OPERATOR approved; a §0
                          adapted/deferred/cut self-flag is NOT approval>
- Live GUI acceptance:   <operator-driven; PENDING allowed — see Step 4 verdict>
```

Hard rule: **an open, unapproved mismatch stops a fidelity-pass claim.** A §0
`adapted/deferred/cut` flag records a *proposed* deviation; it does not close the
mismatch. Only operator approval moves an item from Open mismatches to
Operator-approved deviations.

Artifact source: prefer the repo's state-by-state comparison harness once it
exists (the deterministic generator/validator); until then the artifact is
operator-captured prototype-vs-actual screenshot pairs per state. Hover/focus-only
states are operator-driven always (no-focus-steal rule, GUI-VERIFICATION.md) —
mark them PENDING, never fabricate them.

### DOCS

```bash
git diff --check
```

Plus: for every file path or command a changed doc cites, confirm it exists
(`ls` / `rg`). Canonical docs (STATUS.md, maps, README, CLAUDE.md) must be
edited in place, never forked into a parallel file.

## Step 3 — Stale-reference sweep

For any rename, removal, or interface change:

```bash
rg "<old name>" --glob '!node_modules' -l
```

across code, tests, docs, configs. Zero hits, or each hit justified in the
report.

## Step 4 — Evidence report

End your report with a literal block:

```text
VERIFICATION
- <command>  → <outcome with headline numbers: "485 pass / 0 fail", "clean", "19/19">
- <command>  → ...
Stale-reference sweep: <clean | N hits, each explained>
Not run: <anything skipped + why + exact command the operator can run>
```

If FIDELITY applied, also paste the filled FIDELITY block (Step 2) **and** this
tiered verdict. The tiers are independent, so a not-yet-run operator GUI step
blocks only the fidelity / overall lines — never engineering:

```text
SURFACE ACCEPTANCE
- Engineering:       PASS | FAIL          (DESKTOP battery)
- Security:          PASS | FAIL | N/A    (hardening smoke)
- Fidelity artifact: PASS | FAIL | N/A    (state-by-state compare; zero open, unapproved mismatches)
- Live fidelity:     PASS | PENDING | N/A (operator GUI acceptance)
- Overall surface acceptance: PASS | PENDING | FAIL
```

Overall is PASS only when every applicable tier is PASS; PENDING when an
applicable tier is PENDING and none FAIL; FAIL if any tier FAILs. Never collapse
these into one ✅ — "engineering + headless complete" is a true, reportable
state, but it is NOT surface acceptance.

## Failure handling

- A failing command STOPS the claim. Report the failure with its output; do
  not weaken a test, prune `eslint-suppressions.json`, loosen a schema, or
  reclassify a red result to make it pass.
- An open, unapproved fidelity mismatch STOPS a surface-acceptance (fidelity /
  overall) claim — not the engineering claim. Do not self-approve a deviation to
  clear it; route it to the operator as Open drift.
- Suspected pre-existing failure: verify against the base — `git show
  <base>:<file>`, or run the same command on a clean checkout (a scratch clone;
  don't create worktrees or stashes in the repo) — then report it as
  pre-existing WITH that proof.
- Steps needing the operator (GUI run, real credentials, real usage/quota):
  list under "Not run" with exact steps. Never claim them done.
