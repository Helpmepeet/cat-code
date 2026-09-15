# `apply_patch` contract refactor: implementation evidence

Date: 2026-09-13

Status: candidate infrastructure implemented; production matching-policy gate unresolved

## Shipped in this change

- Canonical lowercase `apply_patch` registration with legacy `Apply_patch`
  recognition at persisted-history boundaries.
- A bounded Lark generation grammar and parser/grammar agreement fixtures.
- Side-specific canonical newline-marker parsing and explicit legacy structured
  newline normalization.
- A pure, bounded, immutable-source planner for complete ordered update plans.
- Pure candidate application, structured failures, and bounded diagnostics.
- A read-only replay driver that accepts only explicit transcript or manifest
  inputs and compares the current, historical, exact-plan, tolerant-plan, hint,
  and newline policies across complete envelopes.
- Bounded candidate placement metadata in the result schema for a future gated
  production integration.

## Deliberately not activated

`FilePatchTool.call` continues to use the current production matcher. The exact
complete-plan implementation is available through the candidate planner/applier
entrypoints, but the implementation plan requires historical replay and paired
model evaluation before changing production placement semantics. The production
prompt therefore continues to describe the current matcher; the candidate prompt
is exposed separately for evaluation.

## Offline verification

- Focused patch parser, grammar, planner, diagnostics, applier, tool-boundary,
  replay, prompt, history, permission, adapter, memory, sidecar, and renderer
  tests passed.
- The full root development build, desktop renderer TypeScript/build, and
  scoped sidecar TypeScript checks passed.
- Explicit ESLint over the changed root sources reported no errors.
- Prompt snapshots were regenerated and pass their ordinary comparison test.
- `git diff --check` passed.
- A post-implementation review found and repaired an EOF-hint crash, tolerant
  replay tier drift, malformed structured replay handling, stale-plan trust,
  missing parser spans and nonconsecutive-anchor diagnostics, unbounded replay
  and error fields, and a source-disclosing near-match diagnostic.
- The planner now counts plans with an iterative compact frontier rather than
  recursive path enumeration. A 2,000-hunk regression completes without using
  the JavaScript call stack.
- Local Lark 1.3.1 compiled the exact production grammar, accepted a canonical
  update, and rejected a whitespace-only update path. Hosted constrained-decoder
  behavior remains a separate release check.

The broad `bun test app/` suite was also attempted. It did not complete because
environment-dependent registry identity, runtime initialization, MCP readiness,
and missing Anthropic-credential tests failed or timed out. Focused tests for the
changed desktop projection and peer-summary paths passed, and desktop typecheck
and renderer build passed. No result from that broad attempt is counted as
evidence for changing the matching policy.

The repository-wide `bun run typecheck` remains red with thousands of existing
cross-workspace and test-fixture diagnostics. It is not counted as a passing
check; the build and package-scoped checks above are the applicable signal for
this change.

## Evidence still required before production activation

- Freeze the evaluation manifest and provide explicit historical session/source
  snapshots for the supplied-session and ambiguity cohorts.
- Replay every reconstructable call as a complete envelope and enumerate unknown
  cases without counting them as success.
- Meet the ambiguity and tolerant-success cohort floors in the implementation
  plan.
- Run the fixed model task suite at least three times per contract and supported
  model/provider configuration, with explicit authorization for live capacity.
- Confirm zero consequential wrong-region placements and no regression against
  the predeclared task-correctness and unrecoverable-failure thresholds.
- Verify old-session resume against the live backend with explicit authorization.

## Compatibility boundary

The rebuilt runtime consumes both canonical `apply_patch` and historical
`Apply_patch` records. A pre-refactor binary knows only the historical spelling,
so downgrading that binary after a new runtime has persisted lowercase calls is
unsupported. Current launchers must be upgraded together; this is distinct from
the required old-session-to-new-runtime compatibility path.

Until those gates are satisfied, the correct release decision is to keep the
current production placement policy while retaining the candidate planner,
diagnostics, grammar, name migration, and replay infrastructure.
