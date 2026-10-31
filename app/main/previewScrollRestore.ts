import type { FilePreviewScroll } from '../shared/filePreview.js'

type PreviewScrollFrame = { executeJavaScript: (source: string) => Promise<unknown> }

/** Page-owned scroll hooks must not hold up publication of a loaded preview. */
export function restorePreviewScroll(frame: PreviewScrollFrame, scroll: FilePreviewScroll): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, 150)
    const finish = () => { clearTimeout(timer); resolve() }
    try {
      void frame.executeJavaScript(`void scrollTo(${scroll.x},${scroll.y})`).then(finish, finish)
    } catch { finish() }
  })
}
