import { useState } from 'react'
import { useToast } from './toastContext.js'

export function PathCopyButton({ label, path }: { label: string; path: string }) {
  const [copied, setCopied] = useState(false)
  const toast = useToast()
  const copy = (): void => {
    const clipboard =
      typeof navigator !== 'undefined' ? navigator.clipboard : undefined
    if (!clipboard) {
      toast('Could not write to the clipboard', { tone: 'warn' })
      return
    }
    void clipboard
      .writeText(path)
      .then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1200)
        toast('Path copied to clipboard', { tone: 'success' })
      })
      .catch(() => {
        toast('Could not write to the clipboard', { tone: 'warn' })
      })
  }

  return (
    <button
      aria-label={copied ? `${label} copied` : `Copy ${label}`}
      className={`shrink-0 rounded-md border border-shell-seam px-2 py-0.5 text-[10.5px] transition-colors ${
        copied
          ? 'text-[light-dark(#15803d,#86efac)]'
          : 'text-text-subtle hover:bg-shell-hover hover:text-text-primary'
      }`}
      onClick={copy}
      title={`Copy ${label}`}
      type="button"
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
  )
}
