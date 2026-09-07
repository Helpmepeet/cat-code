import type { LineEndingType } from '../../utils/fileRead.js'
import { END_OF_FILE_MARKER } from './constants.js'
import {
  FilePatchError,
  type ApplyPatchFileState,
  type ApplyPatchResult,
  type FilePatchBuffer,
  type FilePatchFailureDetail,
  type FilePatchHunk,
  type FilePatchLine,
  type FilePatchOperation,
  MAX_FILE_PATCH_FAILURE_DETAIL_MESSAGE_LENGTH,
  MAX_FILE_PATCH_FAILURE_DETAILS,
} from './types.js'

export function applyPatchToBuffers(
  operations: FilePatchOperation[],
  currentFiles: Map<string, ApplyPatchFileState>,
): ApplyPatchResult {
  try {
    return applyOperations(operations, currentFiles)
  } catch (error) {
    if (error instanceof FilePatchError) {
      throw new FilePatchError(
        `${error.message} No files were changed by this patch.`,
        {
          code: error.code,
          path: error.path,
          operation: error.operation,
          moveTo: error.moveTo,
          hunkIndex: error.hunkIndex,
          hunkCount: error.hunkCount,
          details: error.details,
          mutationOutcome: 'no-mutation',
        },
      )
    }
    throw error
  }
}

function applyOperations(
  operations: FilePatchOperation[],
  currentFiles: Map<string, ApplyPatchFileState>,
): ApplyPatchResult {
  const results: ApplyPatchResult['files'] = []
  const failures: FilePatchFailureDetail[] = []

  for (const operation of operations) {
    try {
      results.push(
        ...applyOperation(
          operation,
          currentFiles,
        ),
      )
    } catch (error) {
      failures.push(toFailureDetail(error, operation))
    }
  }

  if (failures.length > 0) {
    const displayedFailures = failures.slice(0, MAX_FILE_PATCH_FAILURE_DETAILS)
    const omittedFailureCount = failures.length - displayedFailures.length
    const operationWord = failures.length === 1 ? 'operation' : 'operations'
    const omitted =
      omittedFailureCount > 0
        ? ` ${omittedFailureCount} additional failure${omittedFailureCount === 1 ? '' : 's'} omitted.`
        : ''
    const detailText = displayedFailures
      .map(formatFailureDetail)
      .join('\n')
    const first = displayedFailures[0]!
    throw new FilePatchError(
      `Apply_patch preflight failed for ${failures.length} independent ${operationWord}.${omitted}\n${detailText}`,
      {
        code: failures.length === 1 ? first.code : 'PATCH_PREFLIGHT_FAILED',
        path: first.path,
        operation: first.operation,
        moveTo: first.moveTo,
        hunkIndex: first.hunkIndex,
        hunkCount: first.hunkCount,
        details: displayedFailures,
      },
    )
  }

  return { files: results }
}

function applyOperation(
  operation: FilePatchOperation,
  currentFiles: Map<string, ApplyPatchFileState>,
): ApplyPatchResult['files'] {
  const current = getExistingOrDefaultState(currentFiles, operation.path)

  switch (operation.type) {
    case 'update': {
      if (!current.exists) {
        throw new FilePatchError(
          `Cannot update ${operation.path} because it does not exist.`,
          {
            code: 'PATCH_TARGET_MISSING',
            path: operation.path,
            operation: 'update',
            hunkCount: operation.hunks.length,
          },
        )
      }

      if (operation.moveTo) {
        const moveTarget = getExistingOrDefaultState(currentFiles, operation.moveTo)
        if (moveTarget.exists) {
          throw new FilePatchError(
            `Cannot move ${operation.path} to ${operation.moveTo} because the target already exists.`,
            {
              code: 'PATCH_TARGET_EXISTS',
              path: operation.moveTo,
              operation: 'update',
              moveTo: operation.moveTo,
              hunkCount: operation.hunks.length,
            },
          )
        }
      }

      const nextBuffer = applyUpdateHunks(
        current.buffer,
        operation.hunks,
        operation.path,
      ).buffer

      if (operation.moveTo) {
        return [
          {
            path: operation.path,
            type: 'delete',
            before: current.buffer.content,
            after: null,
          },
          {
            path: operation.moveTo,
            type: 'add',
            before: null,
            after: nextBuffer.content,
          },
        ]
      }

      return [
        {
          path: operation.path,
          type: 'update',
          before: current.buffer.content,
          after: nextBuffer.content,
        },
      ]
    }

    case 'add': {
      if (current.exists) {
        throw new FilePatchError(
          `Cannot add ${operation.path} because it already exists.`,
          { code: 'PATCH_TARGET_EXISTS', path: operation.path },
        )
      }

      const content = joinLines(operation.lines, operation.noNewlineAtEndOfFile)
      return [
        {
          path: operation.path,
          type: 'add',
          before: null,
          after: content,
        },
      ]
    }

    case 'delete': {
      if (!current.exists) {
        throw new FilePatchError(
          `Cannot delete ${operation.path} because it does not exist.`,
          { code: 'PATCH_TARGET_MISSING', path: operation.path },
        )
      }

      return [
        {
          path: operation.path,
          type: 'delete',
          before: current.buffer.content,
          after: null,
        },
      ]
    }
  }
}

function toFailureDetail(
  error: unknown,
  operation: FilePatchOperation,
): FilePatchFailureDetail {
  const patchError =
    error instanceof FilePatchError
      ? error
      : new FilePatchError(error instanceof Error ? error.message : String(error))
  return {
    code: patchError.code,
    operation: operation.type,
    path: patchError.path ?? operation.path,
    ...(operation.type === 'update' && operation.moveTo
      ? { moveTo: operation.moveTo }
      : {}),
    ...(patchError.hunkIndex !== undefined
      ? { hunkIndex: patchError.hunkIndex }
      : {}),
    ...(patchError.hunkCount !== undefined
      ? { hunkCount: patchError.hunkCount }
      : {}),
    message: boundFailureMessage(patchError.message),
  }
}

function boundFailureMessage(message: string): string {
  if (message.length <= MAX_FILE_PATCH_FAILURE_DETAIL_MESSAGE_LENGTH) {
    return message
  }
  return `${message.slice(0, MAX_FILE_PATCH_FAILURE_DETAIL_MESSAGE_LENGTH - 20)}… [truncated]`
}

function formatFailureDetail(detail: FilePatchFailureDetail): string {
  const hunk =
    detail.hunkIndex !== undefined
      ? `, hunk ${detail.hunkIndex}${detail.hunkCount !== undefined ? ` of ${detail.hunkCount}` : ''}`
      : ''
  const move = detail.moveTo === undefined ? '' : ` to ${detail.moveTo}`
  return `[${detail.code}] ${detail.operation} ${detail.path}${move}${hunk}: ${detail.message}`
}

export function applyUpdateHunks(
  buffer: FilePatchBuffer,
  hunks: FilePatchHunk[],
  path: string,
): { buffer: FilePatchBuffer } {
  let lines = splitPreservingTerminalNewline(buffer.content)
  let noNewlineAtEndOfFile =
    buffer.noNewlineAtEndOfFile ?? !buffer.content.endsWith('\n')

  // Hunks of one update apply in file order, so a later hunk may only match
  // at-or-after where the previous one finished. The cursor carries that
  // position in the coordinates of the mutated buffer the next hunk searches,
  // which is what lets the canonical Codex idiom work: an early hunk anchors
  // uniquely and a later one uses a tiny fingerprint meaning "the next one".
  let cursor = 0
  for (let i = 0; i < hunks.length; i++) {
    const next = applySingleHunk(
      lines,
      hunks[i],
      path,
      i,
      hunks.length,
      cursor,
    )
    lines = next.lines
    cursor = next.cursor
    if (next.touchesEndOfFile) {
      noNewlineAtEndOfFile = hunks[i].noNewlineAtEndOfFile
    }
  }

  return {
    buffer: {
      content: joinLines(lines, noNewlineAtEndOfFile),
      encoding: buffer.encoding,
      lineEndings: buffer.lineEndings,
      noNewlineAtEndOfFile,
    },
  }
}

function applySingleHunk(
  lines: string[],
  hunk: FilePatchHunk,
  path: string,
  hunkIndex: number,
  hunkCount: number,
  cursor: number,
): {
  lines: string[]
  touchesEndOfFile: boolean
  cursor: number
} {
  const position = findHunkPosition(
    lines,
    hunk,
    path,
    hunkIndex,
    hunkCount,
    cursor,
  )
  const matchIndex = position.index

  let sourceIndex = matchIndex
  const nextLines = lines.slice(0, matchIndex)
  const addedLines: string[] = []

  for (const line of hunk.lines) {
    switch (line.kind) {
      case 'context': {
        const actual = lines[sourceIndex]
        if (actual === undefined) {
          throw new FilePatchError(
            `Context line out of bounds in ${path} at position ${sourceIndex} — re-read the file and verify context.`,
            {
              code: 'PATCH_CONFLICT',
              path,
              hunkIndex: hunkIndex + 1,
              hunkCount,
            },
          )
        }
        // Write back the original file bytes (fuzzy match accepted them as equivalent)
        nextLines.push(actual)
        sourceIndex += 1
        break
      }
      case 'delete': {
        const actual = lines[sourceIndex]
        if (actual === undefined) {
          throw new FilePatchError(
            `Delete line out of bounds in ${path} at position ${sourceIndex} — re-read the file and verify the delete target.`,
            {
              code: 'PATCH_CONFLICT',
              path,
              hunkIndex: hunkIndex + 1,
              hunkCount,
            },
          )
        }
        sourceIndex += 1
        break
      }
      case 'add': {
        nextLines.push(line.text)
        addedLines.push(line.text)
        break
      }
    }
  }

  // Everything this hunk pushed sits between matchIndex and here, so this is
  // where the next hunk may start looking in the buffer it will search.
  const nextCursor = nextLines.length

  nextLines.push(...lines.slice(sourceIndex))

  return {
    lines: nextLines,
    touchesEndOfFile: isTouchingEndOfFile(lines, hunk.lines, matchIndex, addedLines),
    cursor: nextCursor,
  }
}

function isTouchingEndOfFile(
  originalLines: string[],
  hunkLines: FilePatchLine[],
  matchIndex: number,
  addedLines: string[],
): boolean {
  const consumedNonAdds = hunkLines.filter(line => line.kind !== 'add').length
  const touchesEndOfFile = matchIndex + consumedNonAdds === originalLines.length
  if (!touchesEndOfFile) {
    return false
  }

  return addedLines.length > 0 || hunkLines.some(line => line.kind === 'delete')
}

// The fuzzy ladder ported from Codex seek_sequence, widest tolerance last.
// Anything asking "would the matcher have accepted this line?" — placement and
// the failure diagnostics alike — has to ask it of the same ladder, or the
// diagnosis contradicts the decision it is explaining.
const MATCH_TIERS: Array<(a: string, b: string) => boolean> = [
  (a, b) => a === b,
  (a, b) => a.trimEnd() === b.trimEnd(),
  (a, b) => a.trim() === b.trim(),
  (a, b) => unicodeNormalize(a) === unicodeNormalize(b),
]

function describeFingerprintMiss(
  fileLines: string[],
  fingerprint: string[],
  path: string,
): { kind: 'absent' | 'nonconsecutive'; clause: string } {
  const absent = fingerprint.filter(
    text =>
      !MATCH_TIERS.some(
        matchFn => findAllMatches(fileLines, [text], 0, matchFn).length > 0,
      ),
  )

  if (absent.length === 0) {
    return {
      kind: 'nonconsecutive',
      clause: `Every fingerprint line appears in ${path}, but the lines are not one consecutive ordered run in the current file.`,
    }
  }

  const remaining = absent.length - 1
  const others =
    remaining > 0
      ? ` ${remaining} other line${remaining > 1 ? 's' : ''} in this hunk ${remaining > 1 ? 'are' : 'is'} missing from the file too.`
      : ''
  return {
    kind: 'absent',
    clause: `The line ${JSON.stringify(absent[0])} does not appear anywhere in ${path}.${others}`,
  }
}

function findHunkPosition(
  fileLines: string[],
  hunk: FilePatchHunk,
  path: string,
  hunkIndex: number,
  hunkCount: number,
  cursor: number,
): { index: number } {
  const fingerprint = hunk.lines.filter(l => l.kind !== 'add').map(l => l.text)
  // A section with one hunk needs no ordinal. Naming one of many is what lets
  // the model correct the hunk that failed instead of re-checking all of them
  // against the file, which is the whole cost of a placement failure.
  const hunkLabel = hunkCount > 1 ? ` (hunk ${hunkIndex + 1} of ${hunkCount})` : ''

  // Pure-insert hunk (no context, no delete lines)
  if (fingerprint.length === 0) {
    const effectiveHints = hunk.scopeHints.filter(h => h.trim().length > 0)
    if (
      effectiveHints.length > 0 &&
      !scopeHintsAppearInOrder(fileLines, effectiveHints)
    ) {
      throw new FilePatchError(
        `Patch hunk scope does not appear in ${path}${hunkLabel}. Use scope text that exists in the current file.`,
        {
          code: 'PATCH_SCOPE_NOT_FOUND',
          path,
          hunkIndex: hunkIndex + 1,
          hunkCount,
        },
      )
    }
    if (hunk.isEndOfFile) {
      return { index: fileLines.length }
    }
    if (hunkIndex === 0) {
      // Canonical Codex BOF: pure +lines as the first hunk prepend to the file
      return { index: 0 }
    }
    throw new FilePatchError(
      `Patch hunk for ${path}${hunkLabel} has no context or delete lines — pure-insert hunks only work as the first hunk (BOF) or with "*** End of File". Add context lines to locate this hunk.`,
      {
        code: 'INVALID_PATCH_FORMAT',
        path,
        hunkIndex: hunkIndex + 1,
        hunkCount,
      },
    )
  }

  // EOF-anchored: try all tiers tail-first, then fall back to a full scan if
  // nothing matched at the tail (mirrors Codex seek_sequence eof behavior).
  const searchPasses = hunk.isEndOfFile
    ? [Math.max(0, fileLines.length - fingerprint.length), 0]
    : [0]

  const effectiveHints = hunk.scopeHints.filter(h => h.trim().length > 0)
  let sawFingerprintMatch = false
  let sawScopedMatch = false

  for (const searchStart of searchPasses) {
    for (const matchFn of MATCH_TIERS) {
      const matches = findAllMatches(fileLines, fingerprint, searchStart, matchFn)
      if (matches.length === 0) continue
      sawFingerprintMatch = true

      // A supplied hint is a constraint. An unqualified match never
      // substitutes for a hunk whose scope was not satisfied.
      const scopedMatches =
        effectiveHints.length === 0
          ? matches
          : disambiguateWithScopeHints(fileLines, matches, effectiveHints)
      if (scopedMatches.length === 0) continue
      sawScopedMatch = true

      const eligibleMatches =
        hunkIndex === 0
          ? scopedMatches
          : scopedMatches.filter(match => match >= cursor)

      if (eligibleMatches.length === 1) {
        return { index: eligibleMatches[0]! }
      }
      if (eligibleMatches.length > 1) {
        throw new FilePatchError(
          `Patch hunk placement is ambiguous in ${path}${hunkLabel}: there are multiple eligible placements at lines ${formatLinePositions(eligibleMatches)}. Add more consecutive context or scope text until exactly one eligible placement remains.`,
          {
            code: 'PATCH_ANCHOR_AMBIGUOUS',
            path,
            hunkIndex: hunkIndex + 1,
            hunkCount,
          },
        )
      }

      if (hunkIndex > 0) {
        throw new FilePatchError(
          `Patch hunk has no eligible placement after the previous hunk in ${path}${hunkLabel}: the current matching lines ${formatLinePositions(scopedMatches)} are before the required file-order cursor. Reorder the hunks to match the file.`,
          {
            code: 'PATCH_ANCHOR_OUT_OF_ORDER',
            path,
            hunkIndex: hunkIndex + 1,
            hunkCount,
          },
        )
      }
    }
    // If tail pass found nothing, the full-scan pass (searchStart=0) will retry
    // from the beginning. Deduplicate: if tail start === 0 (tiny file), one pass suffices.
    if (searchPasses.length > 1 && searchStart === 0) break
  }

  const miss = describeFingerprintMiss(fileLines, fingerprint, path)
  const repair =
    miss.kind === 'absent'
      ? 'Fix that line first, then check the rest against the file: wording, whitespace, and where each line wraps must all match.'
      : 'Use the complete consecutive ordered run from the current file, with blank lines included.'
  const scopeClause =
    effectiveHints.length > 0 && sawFingerprintMatch && !sawScopedMatch
      ? ` The fingerprint appears in ${path}, but no placement satisfies the supplied scope constraints.`
      : ''
  throw new FilePatchError(
    `Patch anchor not found in ${path}${hunkLabel}.${scopeClause} ${miss.clause} ${repair} To append to the end of the file, use "${END_OF_FILE_MARKER}" after the hunk body.`,
    {
      code: 'PATCH_ANCHOR_NOT_FOUND',
      path,
      hunkIndex: hunkIndex + 1,
      hunkCount,
    },
  )
}

function formatLinePositions(positions: number[]): string {
  const shown = positions.slice(0, 20).map(position => position + 1)
  const omitted = positions.length - shown.length
  return `${shown.join(', ')}${omitted > 0 ? `, and ${omitted} more` : ''}`
}

function findAllMatches(
  fileLines: string[],
  fingerprint: string[],
  searchStart: number,
  matchFn: (a: string, b: string) => boolean,
): number[] {
  const matches: number[] = []
  const limit = fileLines.length - fingerprint.length
  for (let i = searchStart; i <= limit; i++) {
    if (fingerprint.every((text, j) => matchFn(fileLines[i + j], text))) {
      matches.push(i)
    }
  }
  return matches
}

// Returns the subset of matches the scope hints allow, or the matches
// unchanged when the hunk carries no effective hint.
function disambiguateWithScopeHints(
  fileLines: string[],
  matches: number[],
  scopeHints: string[],
): number[] {
  const effectiveHints = scopeHints.filter(h => h.trim().length > 0)
  if (effectiveHints.length === 0) {
    return matches
  }

  // For each match position, walk backwards through scope hints (outermost last).
  // A match "wins" if all hints appear in order at-or-before the match position.
  const satisfies = (matchPos: number): boolean => {
    let searchFrom = matchPos
    for (let h = effectiveHints.length - 1; h >= 0; h--) {
      const hint = effectiveHints[h]
      let found = false
      for (let i = searchFrom; i >= 0; i--) {
        if (fileLines[i].trim().includes(hint.trim())) {
          searchFrom = i - 1
          found = true
          break
        }
      }
      if (!found) return false
    }
    return true
  }

  return matches.filter(satisfies)
}

function scopeHintsAppearInOrder(
  fileLines: string[],
  scopeHints: string[],
): boolean {
  let searchFrom = 0
  for (const hint of scopeHints) {
    const needle = hint.trim()
    let found = false
    for (let i = searchFrom; i < fileLines.length; i++) {
      if (fileLines[i].trim().includes(needle)) {
        searchFrom = i + 1
        found = true
        break
      }
    }
    if (!found) return false
  }
  return true
}

function unicodeNormalize(s: string): string {
  return s
    .trim()
    .split('')
    .map(c => {
      const cp = c.codePointAt(0) ?? 0
      // Dashes → '-'
      if (
        (cp >= 0x2010 && cp <= 0x2015) ||
        cp === 0x2212
      ) return '-'
      // Fancy single quotes → "'"
      if (cp >= 0x2018 && cp <= 0x201b) return "'"
      // Fancy double quotes → '"'
      if (cp >= 0x201c && cp <= 0x201f) return '"'
      // Fancy spaces → ' '
      if (
        cp === 0x00a0 ||
        (cp >= 0x2002 && cp <= 0x200a) ||
        cp === 0x202f ||
        cp === 0x205f ||
        cp === 0x3000
      ) return ' '
      return c
    })
    .join('')
}

function getExistingOrDefaultState(
  currentFiles: Map<string, ApplyPatchFileState>,
  path: string,
): ApplyPatchFileState {
  const current = currentFiles.get(path)
  if (current) {
    return {
      path,
      exists: current.exists,
      buffer: { ...current.buffer },
      ...(current.identity !== undefined ? { identity: current.identity } : {}),
    }
  }

  return {
    path,
    exists: false,
    buffer: {
      content: '',
      encoding: 'utf8',
      lineEndings: 'LF',
      noNewlineAtEndOfFile: false,
    },
  }
}

export function serializeBuffer(buffer: FilePatchBuffer): string {
  return applyLineEndingStyle(buffer.content, buffer.lineEndings ?? 'LF')
}

function applyLineEndingStyle(
  content: string,
  lineEndings: LineEndingType,
): string {
  if (lineEndings !== 'CRLF') {
    return content
  }

  return content.replaceAll('\r\n', '\n').split('\n').join('\r\n')
}

function splitPreservingTerminalNewline(content: string): string[] {
  if (!content) {
    return []
  }

  const normalized = content.replaceAll('\r\n', '\n')
  const lines = normalized.split('\n')
  if (normalized.endsWith('\n')) {
    lines.pop()
  }
  return lines
}

function joinLines(lines: string[], noNewlineAtEndOfFile: boolean): string {
  if (lines.length === 0) {
    return ''
  }

  const joined = lines.join('\n')
  return noNewlineAtEndOfFile ? joined : `${joined}\n`
}
