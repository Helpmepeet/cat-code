export const MAX_MOUNTED_OUTPUT_LINES = 200
export const OUTPUT_LINE_HEIGHT = 20

export type LineWindow = {
  start: number
  end: number
  topSpacerHeight: number
  bottomSpacerHeight: number
}

export function selectLineWindow(
  lineCount: number,
  scrollTop: number,
  viewportHeight: number,
  lineHeight: number = OUTPUT_LINE_HEIGHT,
  overscanLines: number = 20,
  maxMountedLines: number = MAX_MOUNTED_OUTPUT_LINES,
): LineWindow {
  if (lineCount <= 0) {
    return { start: 0, end: 0, topSpacerHeight: 0, bottomSpacerHeight: 0 }
  }
  const visibleStart = Math.max(0, Math.floor(scrollTop / lineHeight) - overscanLines)
  const visibleEnd = Math.min(
    lineCount,
    Math.ceil((scrollTop + viewportHeight) / lineHeight) + overscanLines,
  )
  let start = visibleStart
  let end = Math.max(start + 1, visibleEnd)
  if (end - start > maxMountedLines) end = start + maxMountedLines
  if (end > lineCount) {
    end = lineCount
    start = Math.max(0, end - maxMountedLines)
  }
  return {
    start,
    end,
    topSpacerHeight: start * lineHeight,
    bottomSpacerHeight: (lineCount - end) * lineHeight,
  }
}
