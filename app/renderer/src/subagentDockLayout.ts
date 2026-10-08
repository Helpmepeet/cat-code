/** The centered reading column must leave a full gutter for a flat dock. */
export const SUBAGENT_PANEL_WIDTH = 288
export function subagentDockLayout(paneWidth: number, transcriptWidth: number) {
  return {
    flat: (paneWidth - Math.min(paneWidth, transcriptWidth)) / 2 >= SUBAGENT_PANEL_WIDTH + 36,
    fits: paneWidth >= SUBAGENT_PANEL_WIDTH + 48,
  }
}

export function placeSubagentTooltip(
  pane: DOMRect, anchor: DOMRect, tipWidth: number, tipHeight: number, row: boolean,
) {
  const width = Math.min(tipWidth, Math.max(0, pane.width - 16))
  const attached = row && anchor.left - pane.left >= width + 8
  const desiredLeft = attached ? anchor.left - width + 1 : anchor.right - width
  const left = Math.max(pane.left + 8, Math.min(desiredLeft, pane.right - width - 8))
  const desiredTop = attached ? anchor.top : anchor.bottom + 5
  const height = Math.min(attached ? anchor.height : tipHeight, Math.max(0, pane.height - 16))
  const top = Math.max(pane.top + 8, Math.min(desiredTop, pane.bottom - height - 8))
  return { left, top, width, attached, height }
}
