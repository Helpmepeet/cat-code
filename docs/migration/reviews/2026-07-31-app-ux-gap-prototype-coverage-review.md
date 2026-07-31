# App UX gap prototype coverage — adversarial cold review

**Date:** 2026-07-31
**Reviewed artifact:** `docs/migration/reviews/2026-07-31-app-ux-gap-prototype-coverage.md`
**Verdict:** **RED — revise before using as backlog input**

The prototype-source descriptions are mostly careful, and the 38-item arithmetic is reproducible.
The report still fails its load-bearing contract, however: its buckets are supposed to decide what
can be ported, what needs a wire owner, and what requires an operator ruling. One "port now"
instruction produces a dead control if followed literally, and the bucket definitions do not
consistently encode those three dispositions.

## Findings

| ID | Severity | Finding | Evidence and failure scenario | Owner / disposition |
|---|---|---|---|---|
| F1 | **High** | Finding 20's "port now" instruction says to delete the disabled recent row without carrying the identifier required to open a terminal-only recent, so the resulting control is a no-op. | The report classifies 20 as plain A and says to "Port the openability" and "delete the invented disabled recent row" (`2026-07-31-app-ux-gap-prototype-coverage.md:72,189-197,302-303`). Production deliberately defines a history-only recent as `appSessionId: null` (`app/renderer/src/sessionsCatalogState.ts:587-595`) and both the picker handler and App callback return on that value (`app/renderer/src/WelcomeScreen.tsx:243-247`; `app/renderer/src/App.tsx:2890-2893`). Removing only the disabled rendering therefore makes the row look live while every click is discarded. The repository already has the HC1-safe solution: `openHistorySession(engineSessionId)` lets main resolve the workspace from the engine-written baseline, and `openCatalogRow` already uses it for history rows (`app/renderer/src/App.tsx:1709-1757`). | Welcome-launcher owner must retain a representative history `engineSessionId` in `RecentWorkspace` and route null-app-id recents through the existing `openHistorySession` path, with selector and wiring tests. Do not create a path-authored IPC and do not close this as a renderer-only deletion. |
| F2 | **High** | The bucket taxonomy contradicts its own decision/ownership semantics, so the summary cannot safely tell a backlog author what may start. | A-blocked is defined as "design exists but a missing wire seam or unassigned owner prevents starting," while every B item is said to reopen a closed decision (`2026-07-31-app-ux-gap-prototype-coverage.md:21-25`). Yet 9 is plain A even though the report itself requires frame provenance before renderer work (`:58,161-166,308-309`), and 10a is B even though its detailed row says the real file source is blocked on a missing read seam (`:59,220`). Conversely, B contains 3 and 12 despite explicitly saying 3 has no decision doc and is reversible without an operator ruling, while sequencing says 12 needs no decision (`:218,221,302-309`). A consumer following the summary can start the blocked renderer half of 9, park the unratified adaptations 3/12 as operator reopenings, or miss the wire owner for 10a. | Report author must separate **ratified cut/reopening** from **undocumented adaptation**, reclassify seam-blocked 9 and 10a as A-blocked (or define a distinct equivalent), and recompute the totals and sequencing from that normalized disposition. |
| F3 | **Medium** | The report promises an explicit design question for all 21 C items but omits six of them from the only design-question table. | The summary totals 21 C items (`:37`), while the Bucket C table (`:229-246`) covers only 15 atomic items: 13 single rows plus the combined Memory/Agents row. It has no row for 10b, 24a, 25, 26b, 26c, or O2b, despite the sequencing claim that all 21 have their question stated (`:318`). A design-first backlog generated from that section silently loses attachment payload, the `starting` guard, accessibility, light theme, engineering-copy cleanup, and the non-blocking quota question. | Report author should add the six missing rows with concrete questions/dispositions, or stop claiming that the table is the complete design-first input. |
| F4 | **Medium** | The "MEMORY.md oversize advisory" is misreported as a silent condition absent from the app; the app already exposes the real truncation signal, so the missed gap is actionable explanation, not detection. | The report calls this an absent, "real, silent context-loss condition" (`:283-286`). Engine loading marks AutoMem/TeamMem entrypoints whose loaded content differs after the real 200-line/25 KB truncation (`src/utils/claudemd.ts:389-404`; caps in `src/memdir/memdir.ts:34-38`). The sidecar preserves that bit (`app/sidecar/memoryDomain.ts:193-200`) and the page renders a `truncated` pill (`app/renderer/src/MemoryPage.tsx:173-179`). The parity ledger already classifies the prototype banner as adapted for exactly this reason (`docs/migration/PARITY-LEDGER.md:1664`). Treating it as an entirely absent signal can produce duplicate state UI while missing the narrower usability defect: the existing pill does not explain the consequence or tell the user what to do. | Memory-page owner should rewrite this as an enhancement to the existing truncation indicator: add consequence/action copy driven by the existing real bit. Do not introduce a second mock-threshold detector. |

## Nits

- Revision identity is not auditable: the header says the companion audit is rev 3, the body calls
  itself "Rev 2 (this revision)," while the companion audit now records revs 4 and 5 as corrections
  originating from this document (`2026-07-31-app-ux-gap-prototype-coverage.md:4,31`;
  `2026-07-31-app-ux-gap-audit.md:663-694`). Give this artifact one current revision label.
- The accessibility count says the prototype has five `role=` uses (`:78`). There are five static
  `role="..."` attributes plus a dynamic DOM role in `Messages.jsx:1491`; the separate
  `RemoteRolePill role={...}` match is only a component prop. State the counting rule or avoid the
  brittle number.

## Verification boundary

Source-only. No GUI was launched and no app was run. Rendered geometry, focus timing, and interaction
remain unverified. Read-only checks:

```text
VERIFICATION
- git diff --check
  → clean.
- git diff --no-index --check /dev/null docs/migration/reviews/2026-07-31-app-ux-gap-prototype-coverage-review.md
  → clean.
- cited-path existence sweep
  → all cited repository and prototype files exist.
- bun run maps:lint
  → passed 18 maps with 8 pre-existing recommended-section warnings.
- prototype inventory
  → 30 top-level .jsx surfaces confirmed.
Stale-reference sweep: N/A — review-only file addition; no rename, removal, or interface change.
Not run: app tests or GUI; no app code changed, and the review is explicitly source-only.
```

No implementation or reviewed-artifact edits were made.
