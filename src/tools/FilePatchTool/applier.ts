import type { LineEndingType } from '../../utils/fileRead.js'
import { END_OF_FILE_MARKER } from './constants.js'
import {
  FilePatchError,
  type ApplyPatchFileState,
  type ApplyPatchResult,
  type FilePatchBuffer,
  type FilePatchHunk,
  type FilePatchLine,
  type FilePatchOperation,
} from './types.js'

export function applyPatchToBuffers(
  operations: FilePatchOperation[],
  currentFiles: Map<string, ApplyPatchFileState>,
  cachedFiles?: Map<string, string>,
): ApplyPatchResult {
  // Every failure below is raised while the result is still being built in
  // memory, before the caller writes anything (FilePatchTool.tsx keeps that
  // ordering deliberately). State it in the message: a multi-file patch that
  // aborts partway through the operation list otherwise reads as partially
  // applied, and the model re-reads every earlier target to find out.
  try {
    return applyOperations(operations, currentFiles, cachedFiles)
  } catch (error) {
    if (error instanceof FilePatchError) {
      throw new FilePatchError(
        `${error.message} No files were changed by this patch.`,
        { code: error.code, path: error.path },
      )
    }
    throw error
  }
}

function applyOperations(
  operations: FilePatchOperation[],
  currentFiles: Map<string, ApplyPatchFileState>,
  cachedFiles?: Map<string, string>,
): ApplyPatchResult {
  const workingFiles = new Map<string, ApplyPatchFileState>()
  const results: ApplyPatchResult['files'] = []

  for (const operation of operations) {
    const current = getExistingOrDefaultState(currentFiles, workingFiles, operation.path)

    switch (operation.type) {
      case 'update': {
        if (!current.exists) {
          throw new FilePatchError(
            `Cannot update ${operation.path} because it does not exist.`,
            { code: 'PATCH_TARGET_MISSING', path: operation.path },
          )
        }

        const cachedContent = cachedFiles?.get(operation.path)
        const { buffer: nextBuffer, notes } = applyUpdateHunks(
          current.buffer,
          operation.hunks,
          operation.path,
          cachedContent,
        )

        if (operation.moveTo) {
          const moveTarget = getExistingOrDefaultState(currentFiles, workingFiles, operation.moveTo)
          if (moveTarget.exists) {
            throw new FilePatchError(
              `Cannot move ${operation.path} to ${operation.moveTo} because the target already exists.`,
              { code: 'PATCH_TARGET_EXISTS', path: operation.moveTo },
            )
          }
          // Mark original as deleted, new path as added
          workingFiles.set(operation.path, { path: operation.path, exists: false, buffer: current.buffer })
          workingFiles.set(operation.moveTo, { path: operation.moveTo, exists: true, buffer: nextBuffer })
          results.push({ path: operation.path, type: 'delete', before: current.buffer.content, after: null })
          // The hunks landed in the moved-to file, so any placement disclosure
          // belongs on the entry that carries the patched content.
          results.push({
            path: operation.moveTo,
            type: 'add',
            before: null,
            after: nextBuffer.content,
            ...(notes.length > 0 ? { notes } : {}),
          })
        } else {
          workingFiles.set(operation.path, { path: operation.path, exists: true, buffer: nextBuffer })
          results.push({
            path: operation.path,
            type: 'update',
            before: current.buffer.content,
            after: nextBuffer.content,
            ...(notes.length > 0 ? { notes } : {}),
          })
        }
        break
      }

      case 'add': {
        if (current.exists) {
          throw new FilePatchError(
            `Cannot add ${operation.path} because it already exists.`,
            { code: 'PATCH_TARGET_EXISTS', path: operation.path },
          )
        }

        const content = joinLines(operation.lines, operation.noNewlineAtEndOfFile)
        const nextState: ApplyPatchFileState = {
          path: operation.path,
          exists: true,
          buffer: {
            content,
            encoding: current.buffer.encoding ?? 'utf8',
            lineEndings: current.buffer.lineEndings ?? 'LF',
            noNewlineAtEndOfFile: operation.noNewlineAtEndOfFile,
          },
        }
        workingFiles.set(operation.path, nextState)
        results.push({
          path: operation.path,
          type: 'add',
          before: null,
          after: content,
        })
        break
      }

      case 'delete': {
        if (!current.exists) {
          throw new FilePatchError(
            `Cannot delete ${operation.path} because it does not exist.`,
            { code: 'PATCH_TARGET_MISSING', path: operation.path },
          )
        }

        workingFiles.set(operation.path, {
          path: operation.path,
          exists: false,
          buffer: current.buffer,
        })
        results.push({
          path: operation.path,
          type: 'delete',
          before: current.buffer.content,
          after: null,
        })
        break
      }
    }
  }

  return { files: results }
}

export function applyUpdateHunks(
  buffer: FilePatchBuffer,
  hunks: FilePatchHunk[],
  path: string,
  cachedContent?: string,
): { buffer: FilePatchBuffer; notes: string[] } {
  let lines = splitPreservingTerminalNewline(buffer.content)
  const cachedLines = cachedContent !== undefined
    ? splitPreservingTerminalNewline(cachedContent)
    : undefined
  let noNewlineAtEndOfFile =
    buffer.noNewlineAtEndOfFile ?? !buffer.content.endsWith('\n')

  // Hunks of one update apply in file order, so a later hunk may only match
  // at-or-after where the previous one finished. The cursor carries that
  // position in the coordinates of the mutated buffer the next hunk searches,
  // which is what lets the canonical Codex idiom work: an early hunk anchors
  // uniquely and a later one uses a tiny fingerprint meaning "the next one".
  let cursor = 0
  // Running (added − deleted) line count of the hunks already applied, so a
  // disclosure can name the line the model itself read rather than the line of
  // the intermediate buffer this loop is mutating.
  let lineDelta = 0
  const notes: string[] = []

  for (let i = 0; i < hunks.length; i++) {
    const next = applySingleHunk(
      lines,
      hunks[i],
      path,
      i,
      hunks.length,
      cursor,
      lineDelta,
      cachedLines,
    )
    lines = next.lines
    cursor = next.cursor
    lineDelta = next.lineDelta
    if (next.note !== undefined) {
      notes.push(next.note)
    }
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
    notes,
  }
}

function applySingleHunk(
  lines: string[],
  hunk: FilePatchHunk,
  path: string,
  hunkIndex: number,
  hunkCount: number,
  cursor: number,
  lineDelta: number,
  cachedLines?: string[],
): {
  lines: string[]
  touchesEndOfFile: boolean
  cursor: number
  lineDelta: number
  note?: string
} {
  const position = findHunkPosition(
    lines,
    hunk,
    path,
    hunkIndex,
    hunkCount,
    cursor,
    lineDelta,
    cachedLines,
  )
  const matchIndex = position.index

  let sourceIndex = matchIndex
  const nextLines = lines.slice(0, matchIndex)
  const addedLines: string[] = []
  let deletedCount = 0

  for (const line of hunk.lines) {
    switch (line.kind) {
      case 'context': {
        const actual = lines[sourceIndex]
        if (actual === undefined) {
          throw new FilePatchError(
            `Context line out of bounds in ${path} at position ${sourceIndex} — re-read the file and verify context.`,
            { code: 'PATCH_CONFLICT', path },
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
            { code: 'PATCH_CONFLICT', path },
          )
        }
        sourceIndex += 1
        deletedCount += 1
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
    lineDelta: lineDelta + addedLines.length - deletedCount,
    ...(position.note !== undefined ? { note: position.note } : {}),
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

function findHunkPosition(
  fileLines: string[],
  hunk: FilePatchHunk,
  path: string,
  hunkIndex: number,
  hunkCount: number,
  cursor: number,
  lineDelta: number,
  cachedLines?: string[],
): { index: number; note?: string } {
  const fingerprint = hunk.lines.filter(l => l.kind !== 'add').map(l => l.text)
  // A section with one hunk needs no ordinal. Naming one of many is what lets
  // the model correct the hunk that failed instead of re-checking all of them
  // against the file, which is the whole cost of a placement failure.
  const hunkLabel = hunkCount > 1 ? ` (hunk ${hunkIndex + 1} of ${hunkCount})` : ''

  // Pure-insert hunk (no context, no delete lines)
  if (fingerprint.length === 0) {
    if (hunk.isEndOfFile) {
      return { index: fileLines.length }
    }
    if (hunkIndex === 0) {
      // Canonical Codex BOF: pure +lines as the first hunk prepend to the file
      return { index: 0 }
    }
    throw new FilePatchError(
      `Patch hunk for ${path}${hunkLabel} has no context or delete lines — pure-insert hunks only work as the first hunk (BOF) or with "*** End of File". Add context lines to locate this hunk.`,
      { code: 'INVALID_PATCH_FORMAT', path },
    )
  }

  const matchFns: Array<(a: string, b: string) => boolean> = [
    (a, b) => a === b,
    (a, b) => a.trimEnd() === b.trimEnd(),
    (a, b) => a.trim() === b.trim(),
    (a, b) => unicodeNormalize(a) === unicodeNormalize(b),
  ]

  // EOF-anchored: try all tiers tail-first, then fall back to a full scan if
  // nothing matched at the tail (mirrors Codex seek_sequence eof behavior).
  const searchPasses = hunk.isEndOfFile
    ? [Math.max(0, fileLines.length - fingerprint.length), 0]
    : [0]

  for (const searchStart of searchPasses) {
    for (const matchFn of matchFns) {
      const matches = findAllMatches(fileLines, fingerprint, searchStart, matchFn)
      if (matches.length === 1) {
        return { index: matches[0] }
      }
      if (matches.length > 1) {
        // Hints that narrow to 2+ still have to constrain the cursor rule
        // below, so the subset — not the raw match list — is what carries
        // forward. Hints satisfied by nothing are most likely mis-transcribed;
        // fall back to the unhinted set rather than failing on the hint alone.
        const hinted = disambiguateWithScopeHints(fileLines, matches, hunk.scopeHints)
        const satisfied = hinted.length > 0 ? hinted : matches
        if (satisfied.length === 1) {
          return { index: satisfied[0] }
        }
        if (hunkIndex > 0) {
          // A later hunk's fingerprint is routinely tiny (`})` alone) because
          // the model means "the next one after the previous hunk". Only a
          // hunk with nothing before it has to be globally unique.
          const forward = satisfied.filter(match => match >= cursor)
          if (forward.length > 0) {
            const scope =
              satisfied.length < matches.length
                ? ` (${satisfied.length} within the hinted scope)`
                : ''
            // Report the line in the coordinates of the file the model read:
            // exact when the earlier hunks landed in file order (the normal
            // case), approximate if a uniquely-matched earlier hunk landed
            // later in the file. The structuredPatch in the tool result carries
            // the authoritative final coordinates either way.
            const line = forward[0] + 1 - lineDelta
            return {
              index: forward[0],
              note: `hunk ${hunkIndex + 1} matched ${matches.length} locations${scope}; applied at the first match after the previous hunk (line ${line})`,
            }
          }
          throw new FilePatchError(
            `Patch hunk body is ambiguous in ${path}: all ${matches.length} matches for hunk ${hunkIndex + 1} (lines ${matches.map(i => i + 1).join(', ')}) sit before the position established by the previous hunk — reorder the hunks to match the file, or add more context lines.`,
            { code: 'PATCH_ANCHOR_AMBIGUOUS', path },
          )
        }
        throw new FilePatchError(
          `Patch hunk body is ambiguous in ${path}: the context+delete lines match at ${matches.length} locations (lines ${matches.map(i => i + 1).join(', ')}) — the first hunk of an update must locate itself uniquely; add more surrounding context lines or @@ scope hints until only one location matches.`,
          { code: 'PATCH_ANCHOR_AMBIGUOUS', path },
        )
      }
    }
    // If tail pass found nothing, the full-scan pass (searchStart=0) will retry
    // from the beginning. Deduplicate: if tail start === 0 (tiny file), one pass suffices.
    if (searchPasses.length > 1 && searchStart === 0) break
  }

  // Check whether the cached (previously-read) version of the file would have matched.
  // If so, the file changed on disk after the last read — say that explicitly.
  if (cachedLines !== undefined) {
    for (const matchFn of [
      (a: string, b: string) => a === b,
      (a: string, b: string) => a.trimEnd() === b.trimEnd(),
      (a: string, b: string) => a.trim() === b.trim(),
      (a: string, b: string) => unicodeNormalize(a) === unicodeNormalize(b),
    ]) {
      const cacheMatches = findAllMatches(cachedLines, fingerprint, 0, matchFn)
      if (cacheMatches.length > 0) {
        throw new FilePatchError(
          `Patch anchor not found in ${path}${hunkLabel} — the context matched the previously-read version of the file, but the file has since changed on disk. Re-read the file and rebuild the patch with fresh context.`,
          { code: 'PATCH_ANCHOR_NOT_FOUND', path },
        )
      }
    }
  }

  // With a cached read in hand the loop above already proved the fingerprint
  // matches neither the file nor what was last read from it, so naming
  // staleness here sends the model hunting a concurrent editor that does not
  // exist — a costly wrong turn on a shared tree.
  if (cachedLines !== undefined) {
    throw new FilePatchError(
      `Patch anchor not found in ${path}${hunkLabel} — the hunk's context and delete lines match neither the current file nor the content you last read from it, so they were most likely transcribed inaccurately. Compare them against the file line for line: wording, whitespace, and where each line wraps must all match. To append to the end of the file, use "${END_OF_FILE_MARKER}" after the hunk body.`,
      { code: 'PATCH_ANCHOR_NOT_FOUND', path },
    )
  }

  // Without a cached read the comparison above never ran, so the cause here is
  // genuinely unknown. Asserting staleness would send the model hunting a
  // concurrent editor on nothing but a missing cache entry, and the entry is
  // equally absent when the read was evicted from the read-state cache or
  // happened on another thread — neither says the file changed.
  throw new FilePatchError(
    `Patch anchor not found in ${path}${hunkLabel} — there is no recorded read of this file to compare against, so whether it changed on disk or the context was transcribed inaccurately cannot be told apart here. Re-read the file and rebuild the hunk from what it actually contains. To append to the end of the file, use "${END_OF_FILE_MARKER}" after the hunk body.`,
    { code: 'PATCH_ANCHOR_NOT_FOUND', path },
  )
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
  workingFiles: Map<string, ApplyPatchFileState>,
  path: string,
): ApplyPatchFileState {
  const current = workingFiles.get(path) ?? currentFiles.get(path)
  if (current) {
    return {
      path,
      exists: current.exists,
      buffer: { ...current.buffer },
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
