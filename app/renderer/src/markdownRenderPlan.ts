export const MAX_MARKDOWN_LEAF_LINES = 200
export const MAX_MARKDOWN_LEAF_CHARACTERS = 12_000
export const MAX_MOUNTED_MARKDOWN_LEAVES = 120

export type MarkdownLeafKind = 'markdown' | 'fenced-code' | 'atomic-text'

export type MarkdownRenderLeaf = {
  id: string
  kind: MarkdownLeafKind
  content: string
  startLine: number
  endLine: number
  estimatedHeight: number
}

export type MarkdownLeafWindow = {
  start: number
  end: number
  topSpacerHeight: number
  bottomSpacerHeight: number
}

/**
 * Produces bounded source leaves before Markdown creates a React tree. The
 * scanner intentionally recognizes only block boundaries that can be preserved
 * without importing an undocumented parser dependency. An oversized atomic
 * paragraph is emitted as plain text leaves rather than handing Blink one huge
 * wrapping text node.
 */
export function planMarkdownLeaves(
  sourceId: string,
  source: string,
): MarkdownRenderLeaf[] {
  const lines = source.split('\n')
  const leaves: MarkdownRenderLeaf[] = []
  let blockStart = 0
  let block: string[] = []

  const append = (kind: MarkdownLeafKind, content: string[], startLine: number) => {
    if (content.length === 0) return
    const text = content.join('\n')
    if (text.length > MAX_MARKDOWN_LEAF_CHARACTERS && content.length === 1) {
      for (let offset = 0; offset < text.length; offset += MAX_MARKDOWN_LEAF_CHARACTERS) {
        const chunk = text.slice(offset, offset + MAX_MARKDOWN_LEAF_CHARACTERS)
        leaves.push({
          id: `${sourceId}:${startLine}:${offset}`,
          kind: 'atomic-text',
          content: chunk,
          startLine,
          endLine: startLine,
          estimatedHeight: estimateHeight(chunk, 1),
        })
      }
      return
    }

    let start = 0
    while (start < content.length) {
      let end = Math.min(start + MAX_MARKDOWN_LEAF_LINES, content.length)
      let textLength = content.slice(start, end).join('\n').length
      while (end > start + 1 && textLength > MAX_MARKDOWN_LEAF_CHARACTERS) {
        end -= 1
        textLength = content.slice(start, end).join('\n').length
      }
      const chunk = content.slice(start, end)
      const chunkStartLine = startLine + start
      const chunkText = chunk.join('\n')
      leaves.push({
        id: `${sourceId}:${chunkStartLine}:0`,
        kind,
        content: chunkText,
        startLine: chunkStartLine,
        endLine: chunkStartLine + chunk.length - 1,
        estimatedHeight: estimateHeight(chunkText, chunk.length),
      })
      start = end
    }
  }

  const flushBlock = () => {
    append('markdown', block, blockStart)
    block = []
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const fence = /^ {0,3}(`{3,}|~{3,})[^`~]*$/.exec(line)
    if (!fence) {
      if (block.length === 0) blockStart = index
      block.push(line)
      continue
    }

    flushBlock()
    const marker = fence[1]
    const closing = new RegExp(`^ {0,3}${marker[0]}{${marker.length},}\\s*$`)
    let close = index + 1
    while (close < lines.length && !closing.test(lines[close])) close += 1

    const end = close < lines.length ? close : lines.length - 1
    const header = lines[index]
    const body = lines.slice(index + 1, end)
    const chunks = Math.max(1, Math.ceil(body.length / MAX_MARKDOWN_LEAF_LINES))
    for (let chunkIndex = 0; chunkIndex < chunks; chunkIndex += 1) {
      const from = chunkIndex * MAX_MARKDOWN_LEAF_LINES
      const to = Math.min(from + MAX_MARKDOWN_LEAF_LINES, body.length)
      const chunk = body.slice(from, to)
      const content = [header, ...chunk, marker]
      const startLine = index + from
      leaves.push({
        id: `${sourceId}:${startLine}:fence`,
        kind: 'fenced-code',
        content: content.join('\n'),
        startLine,
        endLine: index + to,
        estimatedHeight: estimateHeight(chunk.join('\n'), Math.max(1, chunk.length)) + 56,
      })
    }
    index = end
  }

  flushBlock()
  return leaves
}

/**
 * Selects a bounded range using estimated leaf heights. Browser measurement can
 * replace the estimates without changing the source leaf identities.
 */
export function selectMarkdownLeafWindow(
  leaves: readonly MarkdownRenderLeaf[],
  scrollOffset: number,
  viewportHeight: number,
  overscan: number = 800,
  maxMountedLeaves: number = MAX_MOUNTED_MARKDOWN_LEAVES,
): MarkdownLeafWindow {
  if (leaves.length === 0) {
    return { start: 0, end: 0, topSpacerHeight: 0, bottomSpacerHeight: 0 }
  }

  const startOffset = Math.max(0, scrollOffset - overscan)
  const endOffset = Math.max(startOffset, scrollOffset + viewportHeight + overscan)
  let offset = 0
  let start = 0
  while (start < leaves.length && offset + leaves[start].estimatedHeight < startOffset) {
    offset += leaves[start].estimatedHeight
    start += 1
  }

  let end = start
  let covered = offset
  while (end < leaves.length && covered < endOffset && end - start < maxMountedLeaves) {
    covered += leaves[end].estimatedHeight
    end += 1
  }

  if (end === start) end = Math.min(start + 1, leaves.length)
  const topSpacerHeight = sumHeights(leaves, 0, start)
  const bottomSpacerHeight = sumHeights(leaves, end, leaves.length)
  return { start, end, topSpacerHeight, bottomSpacerHeight }
}

function estimateHeight(content: string, lineCount: number): number {
  const wrappedLines = Math.ceil(content.length / 120)
  return Math.max(lineCount, wrappedLines, 1) * 24
}

function sumHeights(
  leaves: readonly MarkdownRenderLeaf[],
  start: number,
  end: number,
): number {
  let total = 0
  for (let index = start; index < end; index += 1) total += leaves[index].estimatedHeight
  return total
}
