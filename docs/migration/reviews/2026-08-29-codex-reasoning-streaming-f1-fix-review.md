# Codex reasoning streaming F1 fix review

**Commit:** `db3a0513 fix(app): reconcile concurrent Codex reasoning blocks`

**Verdict: GREEN — accept.**

The commit closes F1 from `docs/migration/reviews/2026-08-29-codex-reasoning-streaming-review.md`. No correctness, conformance, security, or scope findings remain.

## Conformance and correctness

Codex may keep summary and raw reasoning blocks open concurrently, then close raw before summary (`src/services/api/codex-fetch-adapter.ts:1928-1935`, `:2155-2193`, `:2378-2380`). The fix resolves each completed thinking block against the unique live block with the same message id and reasoning kind (`app/renderer/src/transcriptProjector.ts:3556-3574`). Both the batch path (`:1841-1847`) and single-frame path (`:2382-2388`) use that resolver.

For the failing sequence, raw resolves to index 1 and is removed from streaming state. Summary then uniquely resolves to index 0. The ordinary current-index/fallback path remains in place when the block is not thinking, no unique match exists, or no streaming state exists. `nextBlockIndexByMessageId` advances from the resolved indexes without moving backward after the reverse-close frames.

The new fixture at `app/renderer/src/sdkMessageFixtures.ts:2020-2194` mirrors the adapter's summary-open, raw-open, raw-close, summary-close ordering. The regression at `app/renderer/src/transcriptProjector.test.ts:525-554` proves distinct ids, indexes, contents, reasoning kinds, and replacement rows. Prefix parity now covers both the ordinary and concurrent fixtures at `app/renderer/src/transcriptProjector.test.ts:5051-5067`.

## Findings

None.

## Nit

The concurrent fixture gives both raw and summary rows signatures. The adapter attaches encrypted content to summary when both blocks are open, leaving raw unsigned (`src/services/api/codex-fetch-adapter.ts:1844-1848`, `:2362-2376`). Signature presence does not participate in index resolution, so this does not weaken the regression's proof or block acceptance, but removing the raw fixture signature would make the sample fully source-faithful.

## Verification rerun

- `bun test app/renderer/src/transcriptProjector.test.ts` — 134 pass, 0 fail.
- `bun test app/renderer/src/reasoningLayout.test.ts app/renderer/src/TranscriptView.test.tsx` — 290 pass, 0 fail.
- `env -u ANTHROPIC_API_KEY -u CLAUDE_CODE_OAUTH_TOKEN -u OPENAI_API_KEY -u CODEX_API_KEY bun test app/` — 4,177 pass, 0 fail across 266 files. No account usage was available to the suite.
- `bun run --cwd app typecheck` — passed.
- `bun run --cwd app typecheck:sidecar` — passed; 5,565 upstream diagnostics ignored.
- `bun run --cwd app renderer:build` — passed, with the existing chunk-size warning.
- `bun run --cwd app test:hardening` — 19/19 passed.
- `git diff --check db3a0513^ db3a0513` — passed.

The commit changes only three renderer files. It does not touch the protocol, preload, main, sidecar, inbound vocabulary, permission boundary, directional frame limits, or secret filtering. The full battery ran in the shared working tree with unrelated concurrent changes present; the reviewed renderer files were clean and every check passed.

## Unverified

Live Desktop Codex rendering remains unverified. The operator check is a fresh development-app launch followed by a Codex turn that emits readable summary and raw reasoning, confirming both rows remain distinct before and after answer text. No GUI was opened and no prompt or account usage was consumed during this review.
