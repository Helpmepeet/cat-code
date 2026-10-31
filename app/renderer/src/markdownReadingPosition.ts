/** A reading position survives a virtualized Markdown document being remounted. */
export type MarkdownReadingPosition = { leafId: string; offset: number }

export function captureMarkdownReadingPosition(scroller: HTMLElement): MarkdownReadingPosition | undefined {
  if (scroller.clientHeight <= 0) return
  const top = scroller.getBoundingClientRect().top
  for (const unit of scroller.querySelectorAll<HTMLElement>('[data-markdown-unit]')) {
    const box = unit.getBoundingClientRect()
    if (box.height > 0 && box.bottom > top && box.top < top + scroller.clientHeight) {
      return { leafId: unit.dataset.markdownUnit!, offset: top - box.top }
    }
  }
}

export function restoreMarkdownReadingPosition(scroller: HTMLElement, position: MarkdownReadingPosition): boolean {
  const unit = [...scroller.querySelectorAll<HTMLElement>('[data-markdown-unit]')]
    .find(element => element.dataset.markdownUnit === position.leafId)
  if (!unit || scroller.clientHeight <= 0 || unit.getBoundingClientRect().height <= 0) return false
  scroller.scrollTop += unit.getBoundingClientRect().top - scroller.getBoundingClientRect().top + position.offset
  return true
}
