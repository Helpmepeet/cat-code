import { type StructuredPatchHunk, structuredPatch } from 'diff'
import { logEvent } from 'src/services/analytics/index.js'
import { getLocCounter } from '../bootstrap/state.js'
import { addToTotalLinesChanged } from '../cost-tracker.js'
import type { FileEdit } from '../tools/FileEditTool/types.js'
import { count } from './array.js'
import { convertLeadingTabsToSpaces } from './file.js'

export const CONTEXT_LINES = 3
export const DIFF_TIMEOUT_MS = 5_000

/**
 * Shifts hunk line numbers by offset. Use when getPatchForDisplay received
 * a slice of the file (e.g. readEditContext) rather than the whole file —
 * callers pass `ctx.lineOffset - 1` to convert slice-relative to file-relative.
 */
export function adjustHunkLineNumbers(
  hunks: StructuredPatchHunk[],
  offset: number,
): StructuredPatchHunk[] {
  if (offset === 0) return hunks
  return hunks.map(h => ({
    ...h,
    oldStart: h.oldStart + offset,
    newStart: h.newStart + offset,
  }))
}

// For some reason, & confuses the diff library, so we replace it with a token,
// then substitute it back in after the diff is computed.
const AMPERSAND_TOKEN = '<<:AMPERSAND_TOKEN:>>'

const DOLLAR_TOKEN = '<<:DOLLAR_TOKEN:>>'

function escapeForDiff(s: string): string {
  return s.replaceAll('&', AMPERSAND_TOKEN).replaceAll('$', DOLLAR_TOKEN)
}

function unescapeFromDiff(s: string): string {
  return s.replaceAll(AMPERSAND_TOKEN, '&').replaceAll(DOLLAR_TOKEN, '$')
}

/**
 * Count lines added and removed in a patch and update the total
 * For new files, pass the content string as the second parameter
 * @param patch Array of diff hunks
 * @param newFileContent Optional content string for new files
 */
export function countLinesChanged(
  patch: StructuredPatchHunk[],
  newFileContent?: string,
): void {
  let numAdditions = 0
  let numRemovals = 0

  if (patch.length === 0 && newFileContent) {
    // For new files, count all lines as additions
    numAdditions = newFileContent.split(/\r?\n/).length
  } else {
    numAdditions = patch.reduce(
      (acc, hunk) => acc + count(hunk.lines, _ => _.startsWith('+')),
      0,
    )
    numRemovals = patch.reduce(
      (acc, hunk) => acc + count(hunk.lines, _ => _.startsWith('-')),
      0,
    )
  }

  addToTotalLinesChanged(numAdditions, numRemovals)

  getLocCounter()?.add(numAdditions, { type: 'added' })
  getLocCounter()?.add(numRemovals, { type: 'removed' })

  logEvent('tengu_file_changed', {
    lines_added: numAdditions,
    lines_removed: numRemovals,
  })
}

export function getPatchFromContents({
  filePath,
  oldContent,
  newContent,
  ignoreWhitespace = false,
  singleHunk = false,
}: {
  filePath: string
  oldContent: string
  newContent: string
  ignoreWhitespace?: boolean
  singleHunk?: boolean
}): StructuredPatchHunk[] {
  const result = structuredPatch(
    filePath,
    filePath,
    escapeForDiff(oldContent),
    escapeForDiff(newContent),
    undefined,
    undefined,
    {
      ignoreWhitespace,
      context: singleHunk ? 100_000 : CONTEXT_LINES,
      timeout: DIFF_TIMEOUT_MS,
    },
  )
  if (!result) {
    return []
  }
  return result.hunks.map(_ => ({
    ..._,
    lines: _.lines.map(unescapeFromDiff),
  }))
}

// ---------------------------------------------------------------------------
// Bounds for patches that get persisted as `toolUseResult` on the transcript
// JSONL. Only the persist sites in FileEditTool/FileWriteTool/FilePatchTool
// apply these: getPatchFromContents itself must stay lossless because
// useDiffInIDE.ts:178 builds the IDE diff from it and getPatchForEdits round-
// trips it back into file content.
// ---------------------------------------------------------------------------

// Language detection reads only a short prefix of the first line: a shebang, or
// a `<?php`/`<?xml` marker (src/native-ts/color-diff/index.ts:437-449). 256 is
// the kernel's own shebang limit (Linux BINPRM_BUF_SIZE), so a longer line can
// never be a working shebang, and the markers need six characters at most.
// Without the cap a minified bundle or single-line JSON puts the whole file on
// line one and back onto the transcript, which is what firstLine replaced.
export const MAX_PERSISTED_FIRST_LINE_LENGTH = 256

// Reads the first line without splitting the whole file: `split('\n')` on an
// 886 KB single-line file allocates every line just to drop them.
export function firstLineForLanguageDetection(
  content: string | null | undefined,
): string | null {
  if (content == null) return null
  const newline = content.indexOf('\n')
  const line = newline === -1 ? content : content.slice(0, newline)
  return line.slice(0, MAX_PERSISTED_FIRST_LINE_LENGTH)
}

// Counts the 1-char +/-/space marker, so this is the whole persisted string.
// An edit ADJACENT to a long line pulls that line in as context, so a single
// 260 KB minified line lands on the transcript even when the edit was tiny.
export const MAX_PERSISTED_PATCH_LINE_LENGTH = 2_000

/**
 * Bound each diff line before the patch is persisted. Safe because no reader
 * reconstructs a file from a persisted patch: every consumer either renders it
 * (StructuredDiff, the desktop DiffView) or counts +/- markers
 * (useTurnDiffs.ts:62, MessageSelector.tsx:751, FileEditToolUpdatedMessage) —
 * and this keeps both the marker and the line count intact, so counts stay
 * exact. Past this width both renderers already degrade anyway: ColorDiff wraps
 * (src/native-ts/color-diff/index.ts:923).
 *
 * Returns the input untouched when nothing exceeded the bound, which is the
 * overwhelmingly common case (99% of real diff lines are under 256 chars).
 */
export function boundPatchLinesForPersistence(
  hunks: StructuredPatchHunk[],
): StructuredPatchHunk[] {
  if (
    !hunks.some(hunk =>
      hunk.lines.some(line => line.length > MAX_PERSISTED_PATCH_LINE_LENGTH),
    )
  ) {
    return hunks
  }
  return hunks.map(hunk => ({
    ...hunk,
    lines: hunk.lines.map(line =>
      line.length > MAX_PERSISTED_PATCH_LINE_LENGTH
        ? line.slice(0, MAX_PERSISTED_PATCH_LINE_LENGTH) + '…'
        : line,
    ),
  }))
}

/**
 * Get a patch for display with edits applied
 * @param filePath The path to the file
 * @param fileContents The contents of the file
 * @param edits An array of edits to apply to the file
 * @param ignoreWhitespace Whether to ignore whitespace changes
 * @returns An array of hunks representing the diff
 *
 * NOTE: This function will return the diff with all leading tabs
 * rendered as spaces for display
 */

export function getPatchForDisplay({
  filePath,
  fileContents,
  edits,
  ignoreWhitespace = false,
}: {
  filePath: string
  fileContents: string
  edits: FileEdit[]
  ignoreWhitespace?: boolean
}): StructuredPatchHunk[] {
  const preparedFileContents = escapeForDiff(
    convertLeadingTabsToSpaces(fileContents),
  )
  const result = structuredPatch(
    filePath,
    filePath,
    preparedFileContents,
    edits.reduce((p, edit) => {
      const { old_string, new_string } = edit
      const replace_all = 'replace_all' in edit ? edit.replace_all : false
      const escapedOldString = escapeForDiff(
        convertLeadingTabsToSpaces(old_string),
      )
      const escapedNewString = escapeForDiff(
        convertLeadingTabsToSpaces(new_string),
      )

      if (replace_all) {
        return p.replaceAll(escapedOldString, () => escapedNewString)
      } else {
        return p.replace(escapedOldString, () => escapedNewString)
      }
    }, preparedFileContents),
    undefined,
    undefined,
    {
      context: CONTEXT_LINES,
      ignoreWhitespace,
      timeout: DIFF_TIMEOUT_MS,
    },
  )
  if (!result) {
    return []
  }
  return result.hunks.map(_ => ({
    ..._,
    lines: _.lines.map(unescapeFromDiff),
  }))
}
