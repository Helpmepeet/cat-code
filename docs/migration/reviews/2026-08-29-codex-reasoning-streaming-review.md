# Codex reasoning streaming commit review

**Commit:** `07e9fde4 feat(app): stream Codex reasoning into the transcript`

**Verdict: RED — rework before acceptance.**

The commit satisfies the original F3 contract for a single reasoning block: readable `thinking_delta` content projects immediately, the authoritative assistant frame replaces the temporary row, malformed deltas are no-ops, duplicate starts preserve accumulated content, result finalization retains interrupted readable output, and both reasoning layouts consume replacement rows. It does not satisfy that contract for the producer's supported summary-plus-raw reasoning sequence.

## Contract and conformance

The written contract is F3 in `docs/reports/2026-08-02-in-turn-activity-ux.md`: accept thinking starts and `thinking_delta` frames, then reconcile the temporary reasoning row with the authoritative assistant block without duplication. The commit's stated acceptance behavior adds interruption retention, empty/encrypted handling, batch parity, and layout replacement coverage.

| Contract item | Conformance |
|---|---|
| Show readable thinking deltas immediately | Implemented for summary and raw deltas |
| Reconcile temporary and authoritative rows by stable identity | Partial: correct for one open reasoning block, incorrect when summary and raw blocks overlap |
| Reconcile on the assistant frame before `content_block_stop` | Partial for the same reason |
| Preserve content across duplicate starts; ignore malformed deltas | Implemented |
| Retain finalized readable content on interruption | Implemented for the current in-memory transcript |
| Avoid an early readable row for empty/encrypted-only reasoning | Implemented |
| Keep single-frame and batch projection equivalent | Implemented for the new fixture, but the fixture omits the failing producer sequence |
| Update trail and blocks layouts after row replacement | Implemented |

The small text-start idempotence change is related hardening, not material scope excess. No protocol, preload, main, sidecar, security-baseline, or locked-decision surface changed.

## Findings

| ID | Severity | Defect | Evidence and failure scenario | Disposition |
|---|---|---|---|---|
| F1 | Medium | Overlapping Codex summary and raw reasoning blocks are reconciled against the last active block index, which drops the raw authoritative row and duplicates the summary. | The adapter can keep `openSummaryBlock` and `openRawBlock` simultaneously (`src/services/api/codex-fetch-adapter.ts:2155-2193`) and closes raw before summary (`src/services/api/codex-fetch-adapter.ts:1928-1935`, invoked at `:2378-2380`). The projector assigns each assistant frame from `currentStreamBlockIndex` (`app/renderer/src/transcriptProjector.ts:2368-2373`), but the raw stop does not reset that index before the summary assistant frame. A source-level reproduction produced two summary rows at indexes 0 and 1 and no raw row. The fixture contains only summary followed by text (`app/renderer/src/sdkMessageFixtures.ts:1872-1954`), so the prefix parity test at `app/renderer/src/transcriptProjector.test.ts:5019-5032` cannot detect this. On an account/model entitled to raw reasoning, the transcript loses the raw reasoning body and displays the summary twice. | Renderer projector owner: carry the completed block index across the assistant-before-stop ordering, and add a summary-plus-raw reverse-close fixture whose single and batch prefixes are compared. |

This is not a second strike. Earlier reviews identified that thinking deltas were absent, not this overlapping-block reconciliation defect.

## Verification rerun

- `bun test app/renderer/src/transcriptProjector.test.ts` — 133 pass, 0 fail.
- `bun test app/renderer/src/reasoningLayout.test.ts` — 20 pass, 0 fail.
- `bun test app/renderer/src/TranscriptView.test.tsx` — 270 pass, 0 fail.
- `env -u ANTHROPIC_API_KEY -u CLAUDE_CODE_OAUTH_TOKEN -u OPENAI_API_KEY -u CODEX_API_KEY bun test app/` — 4,176 pass, 0 fail across 266 files. Credentials were removed so the review consumed no account usage.
- `bun run --cwd app typecheck` — passed.
- `bun run --cwd app typecheck:sidecar` — passed; 5,565 upstream diagnostics ignored.
- `bun run --cwd app renderer:build` — passed, with the existing chunk-size warning.
- `bun run --cwd app test:hardening` — 19/19 passed.
- `git diff --check 07e9fde4^ 07e9fde4` — passed.
- Source-level summary-plus-raw reproduction — failed as described in F1: projected summaries at block indexes 0 and 1, no raw row.

The full battery ran in the shared working tree, which contained unrelated in-progress changes outside this commit. The focused renderer files were clean, and no check failed. The commit itself changes only four renderer files, so it does not widen the sidecar inbound vocabulary, preload bridge, frame limits, secret filtering, or permission boundary.

## Unverified

Live Desktop Codex rendering remains unverified. The exact operator check is to launch a fresh development app, submit a Codex turn that emits readable reasoning, and observe the reasoning row update before answer text. A summary-plus-raw entitlement is required to verify F1 visually. No GUI was opened and no prompt or account usage was consumed during this review.
