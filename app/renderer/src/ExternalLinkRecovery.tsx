import { useEffect, useState } from 'react'
import { getBridge } from './bridge.js'
import { selectedTextInside } from './transcriptPaneFiles.js'
import { UnsavedTextProtection } from './UnsavedTextProtection.js'

export function ExternalLinkRecovery() {
  const [failedExternalUrl, setFailedExternalUrl] = useState<string | null>(null)
  useEffect(() => {
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
          if (!await bridge.openExternalUrl(url.href)) setFailedExternalUrl(url.href)
          else setFailedExternalUrl(current => current === url.href ? null : current)
        } catch { setFailedExternalUrl(url.href) }
      })()
    }
    document.addEventListener('click', openDocumentLink)
    document.addEventListener('auxclick', openDocumentLink)
    return () => {
      document.removeEventListener('click', openDocumentLink)
      document.removeEventListener('auxclick', openDocumentLink)
    }
  }, [])
  return failedExternalUrl ? <UnsavedTextProtection key={failedExternalUrl} message="Could not open this link." text={failedExternalUrl} label="Copy link" /> : null
}
