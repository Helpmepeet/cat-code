import type { FilePreviewTextWindow, FilePreviewTextWindowSide } from '../../shared/filePreview.js'

export function FilePreviewWindowControl({ window: windowed, onSelect }: {
  window?: FilePreviewTextWindow
  onSelect: (side: FilePreviewTextWindowSide) => void
}) {
  if (!windowed?.truncated) return null
  const side = windowed.side === 'start' ? 'end' : 'start'
  const action = side === 'start' ? 'Show start' : 'Show end'
  const description = `Showing the ${windowed.side === 'start' ? 'first' : 'last'} ${formatBytes(windowed.shownBytes)} of ${formatBytes(windowed.totalBytes)} (${windowed.shownBytes.toLocaleString('en-US')} of ${windowed.totalBytes.toLocaleString('en-US')} bytes). Search and Copy use only this window.`
  return <button type="button" className="tool-output-tool file-preview-window-control" aria-label={action} title={`${action}. ${description}`} aria-description={description}
    onClick={() => onSelect(side)}>{side === 'start' ? 'Start' : 'End'}</button>
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${Number((bytes / (1024 * 1024)).toFixed(1))} MiB`
  if (bytes >= 1024) return `${Number((bytes / 1024).toFixed(1))} KiB`
  return `${bytes} B`
}
