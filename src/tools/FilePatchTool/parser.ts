import {
  ADD_FILE_PREFIX,
  DELETE_FILE_PREFIX,
  END_OF_FILE_MARKER,
  HUNK_HEADER_PREFIX,
  MOVE_TO_PREFIX,
  NO_NEWLINE_MARKER,
  PATCH_BEGIN_MARKER,
  PATCH_END_MARKER,
  UPDATE_FILE_PREFIX,
} from './constants.js'
import {
  FilePatchError,
  type FilePatchNewline,
  type FilePatchHunk,
  type FilePatchLine,
  type FilePatchOperation,
  type PatchSourceSpan,
  type ParsedFilePatch,
} from './types.js'

export function parseFilePatch(input: string): ParsedFilePatch {
  const lines = normalizePatchText(input)

  if (lines[0] !== PATCH_BEGIN_MARKER) {
    throw new FilePatchError(
      `Patch must start with "${PATCH_BEGIN_MARKER}" — wrap the entire patch in "${PATCH_BEGIN_MARKER}" ... "${PATCH_END_MARKER}".`,
      { code: 'INVALID_PATCH_ENVELOPE' },
    )
  }

  if (lines.at(-1) !== PATCH_END_MARKER) {
    throw new FilePatchError(
      `Patch must end with "${PATCH_END_MARKER}" — wrap the entire patch in "${PATCH_BEGIN_MARKER}" ... "${PATCH_END_MARKER}".`,
      { code: 'INVALID_PATCH_ENVELOPE' },
    )
  }

  const ops: FilePatchOperation[] = []
  const seenPaths = new Set<string>()
  let index = 1

  while (index < lines.length - 1) {
    const line = lines[index]
    if (!line) {
      // Lenient: skip blank lines between file blocks (matches Codex PARSE_IN_STRICT_MODE=false)
      index += 1
      continue
    }

    const header = parseOperationHeader(line)
    if (!header) {
      throw new FilePatchError(`Unsupported patch header: ${line}`, {
        code: 'INVALID_PATCH_FORMAT',
      })
    }

    if (seenPaths.has(header.path)) {
      throw new FilePatchError(
        `Patch contains multiple operations for ${header.path} — combine them into a single "*** Update File:" block with multiple @@ hunks.`,
        { code: 'DUPLICATE_PATCH_PATH', path: header.path },
      )
    }
    seenPaths.add(header.path)
    index += 1

    if (header.type === 'delete') {
      ops.push(header)
      continue
    }

    if (header.type === 'add') {
      const result = parseAddBody(lines, index, header.path)
      ops.push({
        type: 'add',
        path: header.path,
        lines: result.lines,
        noNewlineAtEndOfFile: result.noNewlineAtEndOfFile,
      })
      index = result.nextIndex
      continue
    }

    // update: optionally consume "*** Move to:" line
    let moveTo: string | undefined
    if (index < lines.length - 1 && lines[index].startsWith(MOVE_TO_PREFIX)) {
      moveTo = parsePath(lines[index], MOVE_TO_PREFIX)
      index += 1
    }

    const result = parseUpdateBody(lines, index, header.path)
    ops.push({
      type: 'update',
      path: header.path,
      ...(moveTo !== undefined ? { moveTo } : {}),
      hunks: result.hunks,
    })
    index = result.nextIndex
  }

  if (ops.length === 0) {
    throw new FilePatchError('Patch does not contain any file operations.', {
      code: 'EMPTY_PATCH',
    })
  }

  return { ops }
}

function normalizePatchText(input: string): string[] {
  // Lenient: unwrap heredoc wrapper (gpt-4.1 quirk, tolerated for all models)
  const trimmed = input.trim()
  const heredocMatch = trimmed.match(/^<<['"']?EOF['"']?\n([\s\S]*)\nEOF$/)
  const effective = heredocMatch ? heredocMatch[1] : input

  const normalized = effective.replaceAll('\r\n', '\n')
  const lines = normalized.split('\n')
  if (lines.at(-1) === '') {
    lines.pop()
  }
  // Only normalize markers that begin at column zero. A leading space is
  // authoritative hunk context, even when the remaining text looks exactly
  // like an operation or EOF marker.
  return lines.map((line, lineIndex) => {
    const trimmed = line.trim()
    if (
      (lineIndex === 0 && trimmed === PATCH_BEGIN_MARKER) ||
      (lineIndex === lines.length - 1 && trimmed === PATCH_END_MARKER)
    ) {
      return trimmed
    }
    if (
      line.startsWith(UPDATE_FILE_PREFIX) ||
      line.startsWith(ADD_FILE_PREFIX) ||
      line.startsWith(DELETE_FILE_PREFIX) ||
      line.startsWith(MOVE_TO_PREFIX)
    ) {
      return line.trimEnd()
    }
    if (line.startsWith(END_OF_FILE_MARKER) && line.trimEnd() === END_OF_FILE_MARKER) {
      return END_OF_FILE_MARKER
    }
    return line
  })
}

/** Convert a zero-based source-line index (or exclusive end index) to spans. */
function lineSpan(startIndex: number, endIndexExclusive = startIndex + 1): PatchSourceSpan {
  return {
    startLine: startIndex + 1,
    endLine: Math.max(startIndex + 1, endIndexExclusive),
  }
}

function parseOperationHeader(line: string): FilePatchOperation | null {
  if (line.startsWith(UPDATE_FILE_PREFIX)) {
    return {
      type: 'update',
      path: parsePath(line, UPDATE_FILE_PREFIX),
      hunks: [],
    }
  }

  if (line.startsWith(ADD_FILE_PREFIX)) {
    return {
      type: 'add',
      path: parsePath(line, ADD_FILE_PREFIX),
      lines: [],
      noNewlineAtEndOfFile: false,
    }
  }

  if (line.startsWith(DELETE_FILE_PREFIX)) {
    return {
      type: 'delete',
      path: parsePath(line, DELETE_FILE_PREFIX),
    }
  }

  return null
}

function parsePath(line: string, prefix: string): string {
  const path = line.slice(prefix.length).trim()
  if (!path) {
    throw new FilePatchError(`Missing path in patch header: ${line}`, {
      code: 'INVALID_PATCH_FORMAT',
    })
  }
  return path
}

function parseAddBody(
  lines: string[],
  startIndex: number,
  path: string,
): {
  lines: string[]
  noNewlineAtEndOfFile: boolean
  nextIndex: number
} {
  const addedLines: string[] = []
  let noNewlineAtEndOfFile = false
  let index = startIndex

  while (index < lines.length - 1 && !isOperationHeader(lines[index])) {
    const line = lines[index]
    if (!line) {
      // Lenient: blank line terminates the Add body (next block starts after)
      break
    }
    if (line === NO_NEWLINE_MARKER) {
      if (addedLines.length === 0) {
        throw new FilePatchError(
          `No-newline marker in add for ${path} must follow an added line.`,
          { code: 'INVALID_PATCH_FORMAT', path },
        )
      }
      noNewlineAtEndOfFile = true
      index += 1
      if (
        index < lines.length - 1 &&
        !isOperationHeader(lines[index]) &&
        lines[index] !== ''
      ) {
        throw new FilePatchError(
          `No-newline marker in add for ${path} must follow the final added line.`,
          { code: 'INVALID_PATCH_FORMAT', path },
        )
      }
      continue
    }

    if (!line.startsWith('+')) {
      throw new FilePatchError(
        `Add File body for ${path} may only contain + lines — prefix every line with "+".`,
        { code: 'INVALID_PATCH_FORMAT', path },
      )
    }

    addedLines.push(line.slice(1))
    index += 1
  }

  return { lines: addedLines, noNewlineAtEndOfFile, nextIndex: index }
}

function parseUpdateBody(
  lines: string[],
  startIndex: number,
  path: string,
): { hunks: FilePatchHunk[]; nextIndex: number } {
  const hunks: FilePatchHunk[] = []
  let index = startIndex

  while (index < lines.length - 1 && !isOperationHeader(lines[index])) {
    const headerLine = lines[index]

    // A hunk starts with @@ (bare) or "@@ <scope hint text>"
    if (!isHunkHeader(headerLine)) {
      throw new FilePatchError(
        `Expected hunk header (@@ ...) in update for ${path}, got: ${headerLine}`,
        { code: 'INVALID_PATCH_FORMAT', path },
      )
    }

    const hunkStartLine = index + 1
    // Collect one or more stacked @@ hint lines. A bare or whitespace-only
    // header contributes no hint constraint.
    const hints: string[] = []
    while (index < lines.length - 1 && isHunkHeader(lines[index])) {
      const hint = lines[index].slice(HUNK_HEADER_PREFIX.length)
      // trim leading space if present (e.g. "@@ class Foo" → "class Foo")
      const normalizedHint = hint.startsWith(' ') ? hint.slice(1) : hint
      if (normalizedHint.trim().length > 0) hints.push(normalizedHint)
      index += 1
    }

    const hunkLines: FilePatchLine[] = []
    const newlineMarkers: Extract<FilePatchNewline, { kind: 'canonical' }>['markers'] = []
    let isEndOfFile = false
    let hunkEndLine = index

    while (
      index < lines.length - 1 &&
      !isHunkHeader(lines[index]) &&
      !isOperationHeader(lines[index])
    ) {
      const line = lines[index]

      if (line === END_OF_FILE_MARKER) {
        isEndOfFile = true
        index += 1
        hunkEndLine = index
        break
      }

      if (line === NO_NEWLINE_MARKER) {
        if (hunkLines.length === 0) {
          throw new FilePatchError(
            `No-newline marker in update for ${path} must follow a hunk line.`,
            { code: 'INVALID_PATCH_FORMAT', path },
          )
        }
        const previous = hunkLines.at(-1)!
        const appliesTo =
          previous.kind === 'delete'
            ? 'old'
            : previous.kind === 'add'
              ? 'new'
              : 'both'
        const claimedSides = new Set(
          newlineMarkers.flatMap(marker =>
            marker.appliesTo === 'both' ? ['old', 'new'] : [marker.appliesTo],
          ),
        )
        const sides = appliesTo === 'both' ? ['old', 'new'] : [appliesTo]
        if (sides.some(side => claimedSides.has(side))) {
          throw new FilePatchError(
            `Duplicate no-newline marker side in update for ${path}.`,
            { code: 'INVALID_PATCH_FORMAT', path },
          )
        }
        newlineMarkers.push({
          afterHunkLine: hunkLines.length - 1,
          appliesTo,
          sourceSpan: lineSpan(index),
        })
        index += 1
        hunkEndLine = index
        continue
      }

      const parsedLine = parseHunkLine(line, path)
      hunkLines.push(parsedLine)
      index += 1
      hunkEndLine = index
    }

    if (hunkLines.length === 0 && !isEndOfFile) {
      throw new FilePatchError(`Update hunk for ${path} is empty.`, {
        code: 'INVALID_PATCH_FORMAT',
        path,
      })
    }

    const newline: Extract<FilePatchNewline, { kind: 'canonical' }> = {
      kind: 'canonical',
      markers: newlineMarkers,
    }
    const parsedHunk: FilePatchHunk = {
      hints,
      lines: hunkLines,
      isEndOfFile,
      newline,
      sourceSpan: lineSpan(hunkStartLine - 1, hunkEndLine),
    }
    hunks.push(parsedHunk)
  }

  if (hunks.length === 0) {
    throw new FilePatchError(`Update File block for ${path} has no hunks.`, {
      code: 'INVALID_PATCH_FORMAT',
      path,
    })
  }

  return { hunks, nextIndex: index }
}

function parseHunkLine(line: string, path: string): FilePatchLine {
  const prefix = line[0]
  const text = line.slice(1)

  switch (prefix) {
    case ' ':
      return { kind: 'context', text }
    case '-':
      return { kind: 'delete', text }
    case '+':
      return { kind: 'add', text }
    default:
      throw new FilePatchError(
        `Invalid hunk line in ${path}: ${line} — each line must start with " " (context), "+" (add), or "-" (delete).`,
        { code: 'INVALID_PATCH_FORMAT', path },
      )
  }
}

function isHunkHeader(line: string): boolean {
  // bare "@@" or "@@ <text>" — must start with exactly "@@"
  return line === HUNK_HEADER_PREFIX || line.startsWith(HUNK_HEADER_PREFIX + ' ')
}

function isOperationHeader(line: string): boolean {
  return (
    line.startsWith(UPDATE_FILE_PREFIX) ||
    line.startsWith(ADD_FILE_PREFIX) ||
    line.startsWith(DELETE_FILE_PREFIX) ||
    line === PATCH_END_MARKER
  )
}

/**
 * Normalize the structured input arm without inventing raw patch locations.
 *
 * Historical structured calls only carried `noNewlineAtEndOfFile`, which is
 * an output-level directive. It cannot prove anything about the source-side
 * final newline, so it is deliberately represented separately from canonical
 * marker evidence.
 */
export function normalizeFilePatchOperations(
  operations: FilePatchOperation[],
): FilePatchOperation[] {
  return operations.map(operation => {
    if (operation.type !== 'update') return { ...operation }

    return {
      ...operation,
      hunks: operation.hunks.map(hunk => {
        const hints = hunk.hints ?? hunk.scopeHints ?? []
        const newline =
          hunk.newline ??
          ({
            kind: 'legacy-output',
            outputAtEof: hunk.noNewlineAtEndOfFile ? 'absent' : 'present',
          } satisfies Extract<FilePatchNewline, { kind: 'legacy-output' }>)
        const normalizedHunk: FilePatchHunk = {
          ...hunk,
          hints,
          newline,
        }
        return normalizedHunk
      }),
    }
  })
}

/** Parse either raw canonical input or historical structured operations. */
export function parseFilePatchInput(
  input: { input: string } | { ops: FilePatchOperation[] },
): ParsedFilePatch {
  return 'input' in input
    ? parseFilePatch(input.input)
    : { ops: normalizeFilePatchOperations(input.ops) }
}

/**
 * Extract all mutation target file paths from an apply_patch input envelope.
 * Handles:
 *   - raw { input: string }
 *   - structured { ops: FilePatchOperation[] }
 *   - raw patch string
 * Collects operation.path for all operations and operation.moveTo for moves.
 * Returns an empty array if input is malformed, missing, or has no operations.
 */
export function getPatchMutationPaths(input: unknown): string[] {
  if (!input) return []

  let ops: FilePatchOperation[] | undefined

  if (typeof input === 'string') {
    try {
      ops = parseFilePatch(input).ops
    } catch {
      return []
    }
  } else if (typeof input === 'object' && input !== null) {
    if ('ops' in input && Array.isArray((input as { ops?: unknown }).ops)) {
      ops = (input as { ops: FilePatchOperation[] }).ops
    } else if (
      'input' in input &&
      typeof (input as { input?: unknown }).input === 'string'
    ) {
      try {
        ops = parseFilePatch((input as { input: string }).input).ops
      } catch {
        return []
      }
    }
  }

  if (!ops || !Array.isArray(ops)) {
    return []
  }

  const paths: string[] = []
  for (const op of ops) {
    if (op && typeof op === 'object' && typeof op.path === 'string' && op.path.length > 0) {
      paths.push(op.path)
      if (op.type === 'update' && typeof op.moveTo === 'string' && op.moveTo.length > 0) {
        paths.push(op.moveTo)
      }
    }
  }

  return Array.from(new Set(paths))
}
