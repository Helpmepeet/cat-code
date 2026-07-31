# App UX gap audit Rev 2 — adversarial cold review

**Date:** 2026-07-31
**Reviewed artifact:** `docs/migration/reviews/2026-07-31-app-ux-gap-audit.md`
**Verdict:** **RED — revise before using as backlog input**

Rev 2 is materially better than the revision history describes, but it still does not meet its
own contract that source-verified claims are "safe to act on." One claim reverses the destructive
behavior of a setting, two proposed fixes do not close the defects they claim to close, and one
supposedly existing renderer data seam does not exist.

## Findings

| ID | Severity | Finding | Evidence and failure scenario | Owner / disposition |
|---|---|---|---|---|
| F1 | **High** | Finding 24 states the opposite of the engine's destructive behavior for transcript retention `0`. | The audit says existing catalog rows are unaffected and the setting governs only future writes (`2026-07-31-app-ux-gap-audit.md:381-385`). Engine truth says `0` writes no new transcripts **and deletes existing transcripts at startup** (`src/utils/settings/types.ts:325-332`; repeated in `src/utils/settings/validationTips.ts:46-54`). Cleanup derives a zero-day cutoff and runs message/session cleanup at startup (`src/utils/cleanup.ts:25-30,575-595`). Acting on the audit would ship a confirmation that understates irreversible data loss; a user could choose `0`, restart, and lose the history the audit says is unaffected. | Audit author must correct finding 24 and its proposed copy before this document feeds implementation. Treat the current recommendation as blocked. |
| F2 | **Medium** | Finding 10 calls file completion a cheap addition over an "existing read seam," but no file-list read seam exists. | The audit's claim is at `2026-07-31-app-ux-gap-audit.md:234-238`. The production model explicitly says file mentions are absent because the engine-side index is **not on the wire** and surfacing it needs a read seam (`app/renderer/src/composerState.ts:60-70`). `MentionPicker` is only a data-source-agnostic primitive whose optional tabs render only when the caller supplies them (`app/renderer/src/MentionPicker.tsx:2-11,51-58,71-102`); App supplies agent items, not a files tab. A renderer-only task based on the audit has no data to render; inventing a channel would cross the preload/sidecar security boundary the report failed to scope. | Reclassify completion as a cross-plane read-seam feature and name a host/sidecar owner plus the normal boundary review. |
| F3 | **Medium** | Finding 12's proposed focus fix restores only Enter while leaving the other advertised shortcuts dead. | The global handler returns for every target under `FOCUSED_KEY_OWNER_SELECTOR` (`app/renderer/src/App.tsx:1968-1977`). The hint advertises Enter, N/Backspace, and Esc (`app/renderer/src/PermissionPrompt.tsx:139-144`). Moving focus to the Allow button makes native Enter click that button, but the same interactive-element guard still suppresses N, Backspace, and Esc. The audit would therefore close a finding while three advertised paths remain false. | Permission UX owner should either focus a non-interactive card target and preserve the global handler, or make the hint/context and per-control keyboard behavior honest. |
| F4 | **Medium** | Finding 11's proposed "seed history from `user-text` rows" imports synthetic interrupt turns into prompt recall. | The audit proposes the unfiltered seed at `2026-07-31-app-ux-gap-audit.md:251-253`, while finding 9 correctly establishes that engine interrupt literals currently project as ordinary `user-text` (`:204-219`). The projector's fallback indeed makes any unprovenanced text a `user-text` row (`app/renderer/src/transcriptProjector.ts:1573-1645`). After restore, Arrow-Up could therefore recall `[Request interrupted by user]` as though the operator had typed it. | Composer-persistence owner must define a human-authored-history predicate first. If current frames cannot distinguish interrupts without a literal heuristic, this remains coupled to finding 9's provenance decision. |
| F5 | **Medium** | Highest-confidence item 7 is not a drop-in mount: `BubbleCopyChip` depends on layout classes `AssistantProse` does not provide. | The audit calls the change self-contained because the chip is generic over `content` (`2026-07-31-app-ux-gap-audit.md:171-182,504-518`). The chip is absolutely positioned, starts at `opacity-0`, and reveals through `group-hover` / `group-focus-within` (`app/renderer/src/TranscriptView.tsx:1329-1357`). `AssistantProse`'s wrapper is neither `relative` nor `group` (`:518-544`). Merely mounting the chip can position it against a distant ancestor and leave it invisible to pointer users. | Keep the feature, but remove it from the "component exists; mount it" confidence class. The implementation must design a positioned group wrapper and account for streaming/collapsed prose. |
| F6 | **Medium** | The all-surfaces pass missed a direct, current violation of the repository's user-visible-copy rule in the core transcript. | `CLAUDE.md` §7 forbids rendering engineering notes and specifically names seam vocabulary. `ImageResultBody` renders "inline image tile pending a projector image-payload seam" directly under successful image output (`app/renderer/src/TranscriptView.tsx:1277-1297`). Finding 26 catches the same defect class in extension notes and notice discriminants (`2026-07-31-app-ux-gap-audit.md:438-445`) but misses this more central transcript instance. | Add it to finding 26 or explain the exclusion. Copy owner should replace it with a user action or omit it. |
| F7 | **Low** | The framing uses the ledger's stale headline count instead of its current "of record" total. | The audit says 127 open rows (`2026-07-31-app-ux-gap-audit.md:42`). The ledger's Part D total reports 145 missing rows and explicitly says Part C contains 145 (`docs/migration/PARITY-LEDGER.md:2594-2604,2616-2618`). The ledger's earlier 127 headline is internally stale. This does not change the UX ranking, but it contradicts the audit's source-verification standard. | Cite Part D's 145 or omit the parity count from this non-parity audit. Separately reconcile the ledger headline. |

## Nits

- The three audit lanes are called "disjoint," but lane C explicitly applies accessibility,
  responsiveness, and theme across the renderer, overlapping lanes A and B
  (`2026-07-31-app-ux-gap-audit.md:23-32`).
- The method says 26 findings remain while also saying two were demoted and one withdrawn; the
  document still contains 26 numbered findings plus O1/O2. Rewrite the accounting so the reviewed
  population is unambiguous (`:33-35,519-526`).
- At least one "source-verified" line anchor has drifted: `AgentsPage.tsx:318` is now the System
  prompt section; the file-path row is at `AgentsPage.tsx:337-342`
  (`2026-07-31-app-ux-gap-audit.md:317-322`).

## Verification boundary

This was a source-only cold review. No GUI was launched. Findings that depend on rendered geometry,
focus timing, or Electron default menu behavior remain unverified unless the audit itself labels
them that way. No implementation or audited-file edits were made.
