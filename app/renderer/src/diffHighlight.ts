import { cloneElement, createElement, isValidElement, type ReactNode } from 'react'

export type HighlightedLine = ReactNode[]

type HighlightedPiece = {
  text: string
  className: string | undefined
}

type WordSegment = {
  value: string
  changed: boolean
}

function appendLines(target: HighlightedLine[], source: HighlightedLine[]): HighlightedLine[] {
  const result = target.map(line => [...line])
  result[result.length - 1].push(...source[0])
  for (let index = 1; index < source.length; index++) {
    result.push([...source[index]])
  }
  return result
}

function nodeLines(node: ReactNode): HighlightedLine[] {
  if (typeof node === 'string') return node.split('\n').map(part => (part === '' ? [] : [part]))
  if (isValidElement<{ children?: ReactNode }>(node)) {
    return highlightedLines(node.props.children).map(children => [cloneElement(node, undefined, ...children)])
  }
  return [[node]]
}

/** Split a once-per-hunk highlighted tree without losing spans that cross lines. */
export function highlightedLines(children: ReactNode): HighlightedLine[] {
  const nodes = Array.isArray(children) ? children : [children]
  return nodes.reduce<HighlightedLine[]>((lines, node) => appendLines(lines, nodeLines(node)), [[]])
}

function collectPieces(nodes: HighlightedLine, inheritedClassName?: string): HighlightedPiece[] {
  const pieces: HighlightedPiece[] = []
  for (const node of nodes) {
    if (typeof node === 'string') {
      pieces.push({ text: node, className: inheritedClassName })
    } else if (isValidElement<{ children?: ReactNode; className?: string }>(node)) {
      const className = [inheritedClassName, node.props.className].filter(Boolean).join(' ') || undefined
      pieces.push(...collectPieces(highlightedLines(node.props.children)[0], className))
    }
  }
  return pieces
}

/**
 * Reapply word-diff washes over highlighted tokens. Token boundaries and word-diff
 * boundaries are independent, so each intersection becomes its own nested span.
 */
export function highlightedWordSegments(
  line: HighlightedLine,
  segments: WordSegment[],
  changedClassName: string,
  unchangedClassName: string,
): ReactNode[] {
  const pieces = collectPieces(line)
  const output: ReactNode[] = []
  let pieceIndex = 0
  let pieceOffset = 0
  let key = 0

  for (const segment of segments) {
    let remaining = segment.value.length
    while (remaining > 0 && pieceIndex < pieces.length) {
      const piece = pieces[pieceIndex]
      const text = piece.text.slice(pieceOffset, pieceOffset + remaining)
      if (text.length === 0) {
        pieceIndex++
        pieceOffset = 0
        continue
      }
      const token = piece.className
        ? createElement('span', { className: piece.className }, text)
        : text
      output.push(
        createElement(
          'span',
          { key: key++, className: segment.changed ? changedClassName : unchangedClassName },
          token,
        ),
      )
      remaining -= text.length
      pieceOffset += text.length
      if (pieceOffset === piece.text.length) {
        pieceIndex++
        pieceOffset = 0
      }
    }
  }

  return output.length > 0 ? output : line
}
