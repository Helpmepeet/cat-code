import { useEffect, useRef, useState } from 'react'

export function UnsavedTextProtection({ message, text, label = 'Copy full text' }: {
  message: string; text: string; label?: string
}) {
  const [copyState, setCopyState] = useState('')
  const currentText = useRef(text)
  currentText.current = text
  useEffect(() => { setCopyState('') }, [text])
  return <section role="alert" className="border border-warning/40 bg-shell-hover p-3 text-text-primary">
    <p>{message}</p>
    <button type="button" onClick={async () => {
      try {
        await navigator.clipboard.writeText(text)
        if (currentText.current === text) setCopyState('Copied.')
      } catch {
        if (currentText.current === text) setCopyState('Could not copy. Select the full text below and copy it manually.')
      }
    }}>{label}</button>
    {copyState ? <p role="status">{copyState}</p> : null}
    <details><summary>Show full text</summary><textarea aria-label="Full unsaved text" readOnly value={text} /></details>
  </section>
}
