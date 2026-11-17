import { useEffect, useRef, useState } from 'react'
import { ActionCopyIcon } from './SessionActionIcons.js'

/** Shared by chat fences and approval previews; copy always uses the full source. */
export function CodeCopyButton({ code, streaming = false, inline = false }: {
  code: string
  streaming?: boolean
  inline?: boolean
}) {
  const [copied, setCopied] = useState(false)
  const reset = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; clearTimeout(reset.current) }
  }, [])
  const label = streaming ? 'Code still writing' : copied ? 'Code copied' : 'Copy code'
  return <>
    <button
      type="button"
      disabled={streaming}
      aria-label={label}
      title={label}
      className={`${inline ? 'inline-command-control' : 'absolute right-2 top-1 z-[1] inline-flex size-7 items-center justify-center rounded-md transition-colors'} ${streaming ? 'cursor-default text-text-ghost' : copied ? 'text-[light-dark(#15803d,#86efac)]' : 'text-text-subtle hover:bg-text-primary/[0.06] hover:text-text-primary'}`}
      onClick={() => {
        if (streaming || !navigator.clipboard) return
        void navigator.clipboard.writeText(code).then(() => {
          if (!mounted.current) return
          clearTimeout(reset.current)
          setCopied(true)
          reset.current = setTimeout(() => setCopied(false), 1200)
        }).catch(() => {})
      }}
    >
      {copied ? <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden><polyline points="20 6 9 17 4 12" /></svg> : <ActionCopyIcon />}
    </button>
    {inline ? <span className="inline-command-tooltip inline-command-copy-tooltip" role="tooltip">{label}</span> : null}
  </>
}
