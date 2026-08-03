# CC-23 Compacted-History Review

**Date:** 2026-08-01  
**Scope:** CC-23 — a compacted terminal transcript opening in the desktop app as a near-empty conversation  
**Review method:** two independent cold-review passes followed by validation, fixes, focused regressions, real worker/socket probes, the full desktop suite, hardening, typechecks, build, and a real-transcript memory measurement  
**Final verdict:** **GREEN for engineering/headless acceptance; operator GUI acceptance remains UNVERIFIED**

## Contract Reviewed

CC-23 separates two histories that must share one durable transcript identity:

- the model resumes from the engine-normalized compacted seed only;
- the desktop displays the bounded archival prefix plus the exact visible projection of that seed;
- provider account refreshes rotate API correlation identity without rotating transcript identity;
- legacy mixed-stamp files use the filename as canonical identity while applying metadata in global append order;
- display/backfill reads stay bounded and surface truncation rather than inventing or leaking divergent history.

The review also checked the locked migration boundaries: no transcript rewrite, protocol-version change, inbound vocabulary expansion, secret-boundary change, settings/schema/registry change, generated-type change, permission change, feature gate, or new visual design.

## Initial Review Verdict

The independent passes returned **YELLOW**. Six findings were validated against the implementation; none was dismissed as a false positive.

| ID | Severity | Validated finding | Resolution |
|---|---:|---|---|
| F1 | High | Display traversal skipped `preservedSegment` relinking, so some compacted histories could duplicate or misplace preserved rows around the seam. | Added display-specific preserved-segment splicing that keeps summarized archival rows, moves the preserved chain after the compact boundary, and emits every UUID once. Added suffix- and prefix-preserved fixtures. Model resume still uses the original engine relinking path. |
| F2 | Medium | Backfill projected raw display rows directly instead of merging against the same normalized resume seed used by live resume. | Backfill now loads the normalized seed, applies `projectResumedHistory`, and calls `mergeDisplayHistoryWithSeed`. An empty normalized seed with non-empty raw display fails closed as truncated instead of leaking divergent rows. The serialized worker probe now includes an unresolved raw tool tail and proves it is excluded. |
| F3 | Medium | Mixed-stamp metadata lookup was not global last-write-wins, and flattening content replacements by session id reordered interleaved records. | Session-scoped maps now delete/reinsert on every append, making map order the global file order. Content replacements are also retained in one global append-order sequence. The mixed-ID fixture uses A→B→C stamps and interleaved A/B replacements. |
| F4 | Medium | Provider identity separation lacked a persistence-level assertion proving that a real refresh leaves the transcript path and record stamps unchanged. | Added a provider refresh persistence test that writes before and after refresh, asserts the transcript id/path remain fixed, the API correlation id rotates, both JSONL records retain the canonical transcript stamp, and no second transcript file appears. |
| F5 | Low | The bounded byte-tail reader always discarded its first buffered line, dropping a complete JSONL record when the read began exactly on a line boundary. | Added a one-byte alignment probe before the 8 MiB payload. The reader discards the first buffered line only when the starting offset is inside a record. Added an exact-boundary regression. |
| F6 | Low | Renderer coverage proved the compact boundary existed but not its exact position between archival and post-compact rows. | Tightened the renderer regression to assert the exact order: archival user row, compact boundary, assistant tail. |

## Final Conformance Review

| Contract | Result | Evidence |
|---|---|---|
| Model receives compacted resume seed only | PASS | Real compacted Unix-socket probe passes; display-only archival recovery never mutates the resume chain. |
| Desktop restores bounded archival history across compact seams | PASS | Ordinary, suffix-preserved, and prefix-preserved seam fixtures pass; renderer order is exact. |
| Backfill and live resume share the same normalized-seed merge | PASS | Real serialized backfill worker probe passes and rejects an unresolved raw tool tail. |
| Transcript identity survives provider refresh | PASS | Persistence-level before/after JSONL test passes; API correlation identity rotates independently. |
| Mixed legacy stamps apply metadata and replacements in append order | PASS | Three-stamp, interleaved-replacement regression passes. |
| Bounded reads preserve complete records and announce truncation | PASS | Message-cap, byte-cap, exact-boundary, and missing-predecessor regressions pass. |
| Protocol/security/locked migration decisions remain unchanged | PASS | No owned protocol, preload, schema, registry, permission, or feature-gate surface changed; hardening is 19/19. |
| Live desktop behavior on the named real transcript | UNVERIFIED | Operator-only GUI acceptance remains pending under the migration GUI-verification policy. |

## Verification Evidence

- Focused projection/render/storage suite: **32 passed, 0 failed, 81 assertions**.
- Final storage suite after the last refactor: **24 passed, 0 failed, 65 assertions**.
- Real serialized backfill worker probe: **2 passed, 0 failed, 43 assertions**.
- Real compacted Unix-socket resume probe: **1 passed, 0 failed, 6 assertions**.
- Full desktop suite: **2,198 passed, 0 failed, 7,772 assertions across 165 files**.
- App TypeScript: clean.
- Scoped sidecar TypeScript: no owned failures; **5,558 upstream diagnostics ignored** by the scoped checker.
- Desktop hardening smoke: **19/19**.
- Full development build: green at **`2.1.87-dev.20260801.t063052.sha8bb244e2`**; workspace-map lint passed with 8 pre-existing recommendations.
- Real 5,813,123-byte transcript display load: **437 messages, not truncated, 28 ms**; maximum-RSS delta over the matching module-only baseline was **39,092,224 bytes (37.3 MiB)**.
- Post-run orphan check: no sidecar process remained.
- `git diff --check`: clean before archival bookkeeping and repeated after it.

## Impact Sweep

The change is deliberately contained to transcript identity, recovery projection, bounded history loading, and associated tests/documentation. It adds no visual treatment, no settings or schema, no registry entry, no generated types, no permission, no feature gate, and no milestone claim in `DONE.md`. Existing bounded drift/truncation diagnostics are sufficient; no new telemetry event is required. The hardening battery covers the unchanged protocol and secret boundaries.

## Remaining Operator Acceptance

Open the real session `638ffb4b-3d2b-4030-9e2a-c94c994462d4` in the desktop app and verify all three observable outcomes:

1. rows before the compact seam render;
2. the compact boundary appears in the correct location;
3. sending the next turn continues from the compacted model context rather than starting a new conversation.

This is the only remaining acceptance item. It is not represented as completed by the headless evidence above.
