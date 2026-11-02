import { useEffect } from 'react'
import { getBridge } from './bridge.js'
import { selectedTextInside } from './transcriptPaneFiles.js'
import { useToast } from './toastContext.js'

export function ExternalLinkRecovery() {
  const toast = useToast()
  useEffect(() => {
    const copyLink = (url: string) => {
      void (async () => {
        try {
          await navigator.clipboard.writeText(url)
          toast('Link copied.', { tone: 'success' })
        } catch {
          toast('Could not copy this link. Click to try again.', {
            tone: 'warn', duration: 0, onAction: () => copyLink(url),
          })
        }
      })()
    }
    const failedLink = (url: string) => {
      toast('Could not open this link. Click to copy it.', {
        tone: 'warn', duration: 0, onAction: () => copyLink(url),
      })
    }
    const openDocumentLink = (event: MouseEvent) => {
      if (event.defaultPrevented || (event.type === 'auxclick' ? event.button !== 1 : event.button !== 0) || !(event.target instanceof Element)) return
      const anchor = event.target.closest<HTMLAnchorElement>('a[href]')
      if (!anchor || anchor.ownerDocument !== document || anchor.hasAttribute('download') || selectedTextInside(anchor)) return
      const href = anchor.getAttribute('href')?.trim()
      if (!href || !/^(?:https?:)?\/\//i.test(href)) return
      let url: URL
      try { url = new URL(anchor.href) } catch { return }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return
      const bridge = getBridge()
      if (typeof bridge?.openExternalUrl !== 'function') return
      event.preventDefault()
      // Frame clicks stay inside their own document. The host independently
      // accepts this fixed method only from the app's main frame.
      void (async () => {
        try {
          if (!await bridge.openExternalUrl(url.href)) failedLink(url.href)
        } catch { failedLink(url.href) }
      })()
    }
    document.addEventListener('click', openDocumentLink)
    document.addEventListener('auxclick', openDocumentLink)
    return () => {
      document.removeEventListener('click', openDocumentLink)
      document.removeEventListener('auxclick', openDocumentLink)
    }
  }, [toast])
  return null
}
