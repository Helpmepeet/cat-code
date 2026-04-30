# GPT `apply_patch` — Codex V4A Alignment Plan

Date: 2026-04-18
Owner: pt
Status: proposed
Related: [docs/gpt-apply-patch-eval-report.md](./gpt-apply-patch-eval-report.md), [docs/gpt-apply-patch-tool-plan.md](./gpt-apply-patch-tool-plan.md), [docs/gpt-apply-patch-ux-improvements-plan.md](./gpt-apply-patch-ux-improvements-plan.md)

---

## Goal

Get GPT-5.4 to **13/13 first-try** on the eval by aligning `FilePatchTool` to the canonical OpenAI Codex V4A `apply_patch` format that GPT-5.x was natively trained on. Stop fighting the model.

Current baseline: 7/13 first-try. Failure mode for #3, #5, #7, #11 is consistent: the model emits well-formed Codex V4A; this fork rejects it because it redefined the format.

---

## Problem: 5 divergences from canonical V4A

Source of truth: `openai/codex` repo — `codex-rs/apply-patch/` (parser.rs, seek_sequence.rs, apply_patch_tool_instructions.md).

| # | Codex canonical (what GPT emits) | This fork (what we accept today) | Eval failures explained |
|---|---|---|---|
| 1 | `@@ <parent scope>` — names enclosing class/function. Optional. Stackable. Bare `@@` allowed. **Anchor is the context+delete block, not the `@@` text.** | `@@ <unique anchor line>` required; treats `@@` text as the match anchor. | #5, #11 — model emits scope name (e.g. `async advance(...)`), we hunt for it as a literal line and miss / mark ambiguous. |
| 2 | EOF marker: literal line `*** End of File` after the hunk body. BOF: just `+` lines at start of first hunk (no marker). | Custom sentinels `@@ >>>BOF<<<` / `@@ >>>EOF<<<` in hunk header, `+` only. | #4a — model writes appended line as context (canonical), we require `+`-only with our sentinel. |
| 3 | Tool name: `apply_patch` (lowercase). | `Apply_patch`. | Subtle — diverges from native training distribution. |
| 4 | Match is **4-tier fuzzy**: exact → `trim_end` → `trim` → unicode-normalize (fancy dashes, curly quotes, NBSP/odd spaces). | Strict byte equality. | Latent. Bites after compaction or copy-paste through a UI that reflows whitespace/punctuation. |
| 5 | Multiple `@@` lines stack as nested scope (class → method). Multiple changes can share one hunk via context, or use additional `@@` blocks. | Each `@@` starts a new hunk; we fingerprint-search per hunk independently. | #7 — multi-edit envelope confuses our parser; correctness depends on hunk independence which canonical doesn't require. |

Root cause behind #3, #5, #7, #11: **we redefined `@@` to mean "anchor line"**. Fix that one misreading and most failures resolve.

---

## Design

### Canonical grammar (target)

```
start: begin_patch hunk+ end_patch
begin_patch: "*** Begin Patch" LF
end_patch:   "*** End Patch" LF?

hunk: add_hunk | delete_hunk | update_hunk
add_hunk:    "*** Add File: " filename LF add_line+
delete_hunk: "*** Delete File: " filename LF
update_hunk: "*** Update File: " filename LF change_move? change?

change_move: "*** Move to: " filename LF
change: (change_context | change_line)+ eof_line?
change_context: ("@@" | "@@ " /(.+)/) LF
change_line:    ("+" | "-" | " ") /(.+)/ LF
eof_line:       "*** End of File" LF
```

### Matching algorithm (target — from `seek_sequence.rs`)

For a fingerprint `pattern[]` (the context + delete lines of a hunk) against `fileLines[]`:

1. **Tier 1 — exact**: `fileLines[i+j] === pattern[j]` for all j.
2. **Tier 2 — trim_end**: compare with trailing whitespace stripped on both sides.
3. **Tier 3 — trim**: compare with leading + trailing whitespace stripped.
4. **Tier 4 — unicode-normalize**: collapse fancy chars to ASCII, then compare.
   - Dashes: U+2010–2015, U+2212 → `-`
   - Quotes: U+2018–201F → `'` or `"`
   - Spaces: U+00A0, U+2002–200A, U+202F, U+205F, U+3000 → ` `

Each tier scans the full file. Stop at the first tier that yields exactly one match. If a tier yields multiple matches, use scope hints (next section). If it yields zero, advance to the next tier. If all four tiers yield zero, fail with `PATCH_ANCHOR_NOT_FOUND` and the canonical fix hint.

### Scope-hint disambiguation

`@@` lines collected at the top of a hunk become `scopeHints: string[]`. They are **disambiguators**, not anchors:

- If fingerprint match is unique, ignore scope hints (they're advisory).
- If multiple matches and `scopeHints.length > 0`: walk hints top-to-bottom. For each hint, find the most recent line ≤ match index that fuzzy-matches the hint. Pick the match whose hint chain is satisfied (each hint appears in order, each at-or-before the match). If still ambiguous, fail with the existing ambiguity error citing collision lines.
- Bare `@@` (no text) is allowed and contributes nothing to disambiguation.

### EOF / BOF handling (target)

- **EOF**: hunk ends with literal line `*** End of File` → set `isEndOfFile = true` on the hunk. Applier anchors fingerprint at `fileLines.length - fingerprint.length` with trailing-newline tolerance.
- **BOF**: pure-insert hunk (no context, no delete, only `+`) appearing as the **first hunk** of an Update File block → insert at index 0. No marker required. (This matches what Codex emits and what GPT does.)
- Drop `>>>BOF<<<` / `>>>EOF<<<` entirely. They are an in-house invention and not in the model's training distribution.

### Parser leniency (target)

Mirror Codex's `PARSE_IN_STRICT_MODE = false` defaults:

- Trim surrounding whitespace from `*** ...` markers before matching.
- If the entire input is wrapped in a heredoc (`<<'EOF'\n...\nEOF\n` or similar), unwrap it before parsing. (GPT-4.1 quirk Codex tolerates.)
- Tolerate trailing-newline differences around `*** End Patch`.

---

## File-by-file changes

### `src/tools/FilePatchTool/constants.ts`

```ts
export const FILE_PATCH_TOOL_NAME = 'apply_patch'   // was 'Apply_patch'
export const PATCH_BEGIN_MARKER = '*** Begin Patch'
export const PATCH_END_MARKER = '*** End Patch'
export const UPDATE_FILE_PREFIX = '*** Update File: '
export const ADD_FILE_PREFIX = '*** Add File: '
export const DELETE_FILE_PREFIX = '*** Delete File: '
export const MOVE_TO_PREFIX = '*** Move to: '       // was MOVE_FILE_PREFIX = '*** Move File: '
export const HUNK_HEADER_PREFIX = '@@'              // bare @@ allowed; trailing space optional
export const END_OF_FILE_MARKER = '*** End of File' // new
export const NO_NEWLINE_MARKER = '\\ No newline at end of file'
// Removed: BOF_SENTINEL, EOF_SENTINEL
```

### `src/tools/FilePatchTool/types.ts`

- `FilePatchHunk`:
  - Replace `header: string` with `scopeHints: string[]`.
  - Add `isEndOfFile: boolean`.
- `FilePatchOperation` `update` variant: add optional `moveTo?: string`.
- Update Zod schemas to match.

### `src/tools/FilePatchTool/parser.ts`

- After `*** Update File: <path>`, optionally consume one `*** Move to: <path>` line into the operation.
- In `parseUpdateBody`:
  - Recognize `@@` and `@@ <text>` as scope-hint lines. Collect zero or more at the top of a hunk into `scopeHints`.
  - A hunk is delimited by: next `@@` after at least one body line, next `*** ` operation header, `*** End Patch`, or `*** End of File` (which closes the current hunk and sets `isEndOfFile`).
  - Allow a hunk with **no scope hints** — body alone is a valid hunk.
  - Recognize `*** End of File` line; set `isEndOfFile = true` on the just-completed hunk; do not advance hunk.
- Add heredoc-unwrap pre-pass: if `input.trim()` starts with `<<'EOF'` (or `<<EOF`, `<<"EOF"`) and ends with `EOF`, strip the wrapper before line-splitting.
- Trim surrounding whitespace on `*** ...` marker lines before prefix-matching.
- Drop `>>>BOF<<<` / `>>>EOF<<<` recognition.

### `src/tools/FilePatchTool/applier.ts`

- Drop `BOF_SENTINEL` / `EOF_SENTINEL` short-circuits.
- Implement `findHunkPosition(fileLines, hunk)`:
  1. Build `fingerprint = hunk.lines.filter(l => l.kind !== 'add').map(l => l.text)`.
  2. **Pure-insert special case** (`fingerprint.length === 0`):
     - If `hunk.isEndOfFile`: position = `fileLines.length`.
     - Else if it's the first hunk in the operation: position = `0`.
     - Else: error — pure-insert mid-file requires context.
  3. **EOF-anchored** (`hunk.isEndOfFile`): try fingerprint at `fileLines.length - fingerprint.length` only; allow the last line of fingerprint to fuzzy-match with trailing-newline tolerance.
  4. **General case**: run 4-tier fuzzy scan. For each tier in order:
     - Collect all matches at that tier.
     - If 1 match → return it.
     - If >1 → apply scope-hint disambiguation; if resolved → return; else throw `PATCH_ANCHOR_AMBIGUOUS` with line numbers + hint to add more context.
     - If 0 → next tier.
  5. All tiers exhausted → throw `PATCH_ANCHOR_NOT_FOUND` with the canonical fix hint.
- After locating, when copying lines through, write back the **original file bytes** for context lines (preserve whatever whitespace/unicode the file actually has), not the patch's version. This matters because fuzzy match accepted them as equivalent.
- Implement `*** Move to:` for update ops: after applying hunks, write the new content to `moveTo` and delete the original path. Touches `FilePatchTool.tsx` `call()` to handle path divergence in `writtenFiles` / rollback.
- Add `unicodeNormalizeForCompare(s: string): string` helper. Keep it scoped to comparison only — never mutate file content.

### `src/tools/FilePatchTool/prompt.ts`

Replace the body with the **verbatim** Codex `apply_patch_tool_instructions.md` text (with file paths in our examples updated to look natural for this repo). Drop BOF/EOF sentinel examples. Add:

- A `@@ class Foo` scope-stacking example.
- A `*** End of File` example.
- A `*** Move to:` example.

The prompt is the highest-leverage surface — GPT has the exact Codex wording in its training distribution. Match it.

### `src/tools/FilePatchTool/UI.tsx`

- Update `userFacingName` and any rendered tool name to `apply_patch`.

### `src/tools/FilePatchTool/FilePatchTool.tsx`

- Handle the new `moveTo` field in `call()`: write to new path, delete old, ensure rollback restores both.
- No changes to `validateInput` flow beyond reading the renamed/new fields.

### `src/tools.ts`, `src/constants/promptStyles/gpt.ts`, anywhere referencing `FILE_PATCH_TOOL_NAME` / `'Apply_patch'`

- Grep for `Apply_patch` and `FILE_PATCH_TOOL_NAME`. Update all references. Confirm the GPT prompt-style registry binds the new name.

### `src/tools/FilePatchTool/__fixtures__/`

Reset to original state. Add new fixtures:

- `13-scope-disambiguation.ts` — three same-named methods on different classes; patch uses `@@ class B` to disambiguate.
- `14-end-of-file-marker.ts` — append using `*** End of File` (canonical) instead of sentinel.
- `15-move-to.ts` — rename a file via `*** Move to:`.
- `16-fuzzy-trailing-whitespace.ts` — file has trailing spaces; patch context lacks them; tier-2 should match.
- `17-fuzzy-unicode.ts` — file has en-dash / curly quotes; patch uses ASCII; tier-4 should match.
- `18-heredoc-wrapped.ts` — full envelope wrapped in `<<'EOF' ... EOF`.

### Tests

- `parser.test.ts` — scope-hint collection, `*** Move to:`, `*** End of File`, heredoc unwrap, bare `@@`, lenient marker whitespace.
- `applier.test.ts` — 4 fuzzy tiers in order, scope-hint disambiguation, EOF anchoring, BOF (first-hunk pure-insert), `Move to:` rename, ambiguity error citing line numbers.
- Keep existing tests green where they reflect canonical behavior; delete tests that asserted on `>>>BOF<<<` / `>>>EOF<<<`.

---

## Out of scope (explicitly)

- Changing `FileEditTool` (Claude path) — untouched.
- Changing the read-gate decision (already ruled out in eval report).
- Reverting or revisiting the full-fingerprint uniqueness check — keep it, it's correct and matches Codex's behavior under the hood.
- Adding telemetry / observability — separate work.

---

## Risks

| Risk | Mitigation |
|---|---|
| Fuzzy match silently mis-locates a hunk in a near-duplicate file region | Apply scope-hint disambiguation; on ambiguity, refuse rather than guess. Always write back original bytes for context. |
| Heredoc unwrap eats real content that happens to look like `EOF` | Only unwrap if both opening and closing markers are present and bracket the entire input after trim. |
| Tool-name rename breaks an in-flight session that has cached schemas | Single-user fork; acceptable. Rebuild = fresh schema. |
| `Move to:` rename + rollback edge cases (target path already exists, original deleted mid-op) | Validate target nonexistence in `validateInput`; rollback restores original at original path and removes new path. |
| GPT occasionally emits the old `>>>EOF<<<` because we trained it during this session | Once the prompt no longer mentions sentinels, the model will stop. New sessions only — no back-compat shim needed. |

---

## Implementation order

1. **constants.ts** — rename + add markers, remove sentinels.
2. **types.ts** — `scopeHints`, `isEndOfFile`, `moveTo`; update Zod.
3. **parser.ts** — scope-hint collection, EOF marker, Move to, heredoc unwrap, lenient markers.
4. **applier.ts** — 4-tier fuzzy match, scope-hint disambiguation, EOF/BOF handling, Move to.
5. **prompt.ts** — replace with canonical Codex text + scope/EOF/Move examples.
6. **UI.tsx + tools.ts + gpt.ts** — name plumbing.
7. **FilePatchTool.tsx** — wire `moveTo` through `call()` + rollback.
8. **Fixtures + tests** — add new, reset old, delete sentinel-specific tests.
9. **Build**: `bun run build:dev:full`.
10. **Run eval**: 13 prompts in a fresh GPT-5.4 session, fixtures reset. Record first-try counts.
11. **Iterate** only on failures that remain.

---

## Success criteria

- Eval first-try rate: **≥ 12/13** (target 13/13).
- Zero references to `>>>BOF<<<`, `>>>EOF<<<`, or `Apply_patch` (capital A) remain.
- `prompt.ts` is verbatim Codex with only example paths localized.
- All four fuzzy tiers exercised by tests.
- `*** Move to:`, `*** End of File`, scope-hint disambiguation each have a passing fixture.

---

## Rollback

Single-feature change. If the eval regresses below 7/13, `git revert` the alignment commit and re-open the eval report with the new failure modes.
