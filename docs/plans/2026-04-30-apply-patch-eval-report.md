# GPT `apply_patch` Eval Report

Date: 2026-04-18
Goal: GPT-5.4 succeeds on all 12 eval scenarios on the first try.
Current result: 7/13 first-try. All scenarios eventually succeeded.

---

## Context

Cat Code is a fork of Claude Code. It supports multiple providers. When the active model is GPT-5.4, the file-editing tool switches from `FileEditTool` (Claude's `old_string`/`new_string` format) to `FilePatchTool` (OpenAI's `apply_patch` V4A unified-diff format).

GPT-5.4 is natively trained on `apply_patch` from the Codex harness. The tool is the right choice for GPT. The failures are not caused by wrong tool choice.

---

## Tool stack

### FilePatchTool
- **Tool name (internal/runtime):** `Apply_patch`
- **Naming note:** Cat Code now keeps this GPT-only tool in the built-in TitleCase naming family because `.claude/settings.local.json` is also shared with Claude Code tooling.
- **Entry:** `src/tools/FilePatchTool/FilePatchTool.tsx`
- **Parser:** `src/tools/FilePatchTool/parser.ts` — parses the patch envelope into operations
- **Applier:** `src/tools/FilePatchTool/applier.ts` — applies operations to file buffers
- **Prompt:** `src/tools/FilePatchTool/prompt.ts` — tool description seen by the model
- **Constants:** `src/tools/FilePatchTool/constants.ts` — sentinel values (`>>>BOF<<<`, `>>>EOF<<<`)
- **Types:** `src/tools/FilePatchTool/types.ts`
- **UI:** `src/tools/FilePatchTool/UI.tsx` — user-facing display name and rendering

### GPT system prompt
- **GPT prompt style:** `src/constants/promptStyles/gpt.ts`
- **Prompt assembly:** `src/utils/systemPrompt.ts`
- The GPT prompt is structured differently from Claude's — contract-first, numbered rules, explicit examples work better than narrative guidance.

### Shared file edit helpers
- `src/tools/FileEditTool/shared.ts` — `validateFileWasRead`, `validateFileNotModifiedSinceRead`, `assertFileUnchangedSinceRead`

### Key design decisions already made
- **Read-gate removed:** `validateFileWasRead` is not called for GPT patch operations. The model reads voluntarily anyway. Reinstating it does not fix format errors.
- **Full-hunk-fingerprint uniqueness:** The applier finds the unique position using the complete sequence of context+delete lines, not just the anchor string. Ambiguous hunks are rejected with a clear error citing collision line numbers.
- **BOF/EOF sentinels:** `@@ >>>BOF<<<` prepends, `@@ >>>EOF<<<` appends. Both require only `+` lines — no context.
- **Remediation hints:** Every error message includes a one-sentence fix hint so the model self-corrects.

---

## Eval scenarios and results

Fixtures live in `src/tools/FilePatchTool/__fixtures__/`. Reset them between runs — stale state from a prior run caused a false failure on #12.

| # | File | Task | Result | Attempts |
|---|---|---|---|---|
| 1 | `01-prepend-comment.ts` | Add `// @ts-nocheck` at top | ✅ | 1 |
| 2 | `02-prepend-empty.ts` | Add `export {}` to empty file | ✅ | 1 |
| 3 | `03-append-closing-brace.ts` | Add property inside class (no trailing newline) | ✅ | 2 |
| 4a | `04a-append-trailing-newline.ts` | Append line (file has trailing newline) | ✅ | 3 |
| 4b | `04b-append-no-trailing-newline.ts` | Append line (no trailing newline) | ✅ | 1 |
| 5 | `05-mid-file-insert.ts` | Add param to multi-line function signature | ✅ | 3 |
| 6 | `06-single-char-delete.ts` | Remove trailing comma | ✅ | 1 |
| 7 | `07-multi-hunk.ts` | Two edits in one envelope (union + new function) | ✅ | 2 |
| 8 | `08-new-file.ts` (created) | Create new file | ✅ | 1 |
| 9 | `09-delete-me.ts` | Delete file | ✅ | 1 |
| 10 | `10-multi-file-a.ts` + `10-multi-file-b.ts` | Edit one file + create another | ✅ | 1 |
| 11 | `11-generic-context.ts` | Edit function near repeated `}` lines | ✅ | 2 |
| 12 | `12-no-prior-read.ts` | Edit without prior Read (file content provided inline) | ✅ | 3 |

---

## Failure analysis

### #3 — Insert inside class with no trailing newline (2 attempts)
- First hunk was syntactically malformed.
- The model had the correct content but got the hunk structure wrong.

### #4a — Append with trailing newline (3 attempts)
- Model used `>>>EOF<<<` but put the not-yet-existing line as a context line instead of a `+` line.
- BOF/EOF examples have since been added to the tool prompt — retest to confirm this is fixed.

### #5 — Multi-line function signature insert (3 attempts)
- Two consecutive format errors.
- The function signature spans multiple lines. The model picked the wrong line as the anchor on the first try, then had a missing anchor on the second.

### #7 — Multi-hunk patch (2 attempts)
- First patch format was malformed.
- The patch contained two `@@` blocks in one envelope.

### #11 — Edit near repeated `}` lines (2 attempts)
- First attempt used `}` as the anchor, which appears in all three functions — ambiguous.
- The fingerprint uniqueness check caught it and returned an error with collision line numbers.
- The model recovered by adding more context on the second attempt.

### #12 — No prior read (3 attempts)
- First attempt failed on format.
- Second attempt failed because the file had been modified earlier in the same session by a prior eval run — `assertFileUnchangedSinceRead` fired correctly.
- Third attempt succeeded after re-reading.
- This is a fixture hygiene problem, not a model error: reset fixtures between runs.

---

## What has already been tried / ruled out

- **Reinstating the Read-gate:** Rejected. The model reads voluntarily on every attempt. Format errors happen after reading, so forcing a read does not help.
- **Switching to FileEditTool for GPT:** Rejected. GPT-5.4 is natively trained on `apply_patch`. `FileEditTool`'s `old_string`/`new_string` format is Claude-native and would introduce a different class of errors.
- **BOF/EOF examples added to tool prompt:** Already done this session. Covers #4a. Needs retest to confirm.

---

## Open problems for the next session

1. **#3, #5, #7, #11** — failures are hunk construction errors, not content errors. The model had the right content but produced an invalid or ambiguous hunk. Root cause is unknown — investigate.

2. **Fixture reset:** Add a script or instruction to reset all fixtures to their original state before each eval run. Currently done manually.

3. **Success metric:** First-try rate should reach 13/13. Current baseline is 7/13 (54%). Retest first with the BOF/EOF examples already added before making further changes.

---

## How to run the eval

1. Reset fixtures to original state (`src/tools/FilePatchTool/__fixtures__/`)
2. Build: `bun run build:dev:full` → produces `./cli-dev`
3. Open a session with GPT-5.4
4. Run each prompt in order in one session (run #9 delete last or separately)
5. Record: first-try success or number of attempts
6. Target: 13/13 first-try

### Eval prompts

1. Add `// @ts-nocheck` at the top of `src/tools/FilePatchTool/__fixtures__/01-prepend-comment.ts`
2. Add `export {}` as the first line of `src/tools/FilePatchTool/__fixtures__/02-prepend-empty.ts`
3. Add a `timeout: number = 30` property to the `Config` class in `src/tools/FilePatchTool/__fixtures__/03-append-closing-brace.ts`
4a. Add `export const AUTHOR = 'pt'` at the end of `src/tools/FilePatchTool/__fixtures__/04a-append-trailing-newline.ts`
4b. Add `export const AUTHOR = 'pt'` at the end of `src/tools/FilePatchTool/__fixtures__/04b-append-no-trailing-newline.ts`
5. Add an `options?: RequestInit` parameter to the `fetchUser` function in `src/tools/FilePatchTool/__fixtures__/05-mid-file-insert.ts`
6. Remove the trailing comma after the type alias declaration in `src/tools/FilePatchTool/__fixtures__/06-single-char-delete.ts`
7. Add `'debug'` to the `LogLevel` union type and add a `debug(message: string): void` function that calls `log('debug', message)` in `src/tools/FilePatchTool/__fixtures__/07-multi-hunk.ts`
8. Create a new file `src/tools/FilePatchTool/__fixtures__/08-new-file.ts` with a single export: `export const CREATED = true`
9. Delete the file `src/tools/FilePatchTool/__fixtures__/09-delete-me.ts`
10. Add a `subtract(a: number, b: number): number` function to `src/tools/FilePatchTool/__fixtures__/10-multi-file-a.ts` and create `src/tools/FilePatchTool/__fixtures__/10-multi-file-b.ts` with a `multiply(a: number, b: number): number` function
11. Add a `return x` statement to `processB` in `src/tools/FilePatchTool/__fixtures__/11-generic-context.ts` and change its return type to `number`
12. Change `TIMEOUT_MS` from `3000` to `5000` in `src/tools/FilePatchTool/__fixtures__/12-no-prior-read.ts`. The file content is: `export const API_URL = 'https://api.example.com'\nexport const TIMEOUT_MS = 3000\nexport const MAX_RETRIES = 3\n`. Do not read the file — use the content provided here directly.
