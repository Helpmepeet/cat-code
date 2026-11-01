import { useRef, useState } from 'react'
import type { RoutingStorageHealth } from '../../shared/projectRouting.js'
import './RoutingStorageRecovery.css'

export function RoutingStorageRecovery({ health, draft, onRevalidate, onInspect }: {
  health: RoutingStorageHealth
  draft: string
  onRevalidate(): Promise<RoutingStorageHealth>
  onInspect(): Promise<void>
}) {
  const busy = useRef(false)
  const [checking, setChecking] = useState(false)
  const [notice, setNotice] = useState('')
  if (health.status === 'healthy') return null

  async function revalidate() {
    if (busy.current) return
    busy.current = true
    setChecking(true)
    setNotice('')
    try {
      const result = await onRevalidate()
      if (result.status === 'blocked') setNotice('The saved message file still cannot be read. Sending remains paused.')
    } catch {
      setNotice('Could not check the saved message file. Sending remains paused.')
    } finally {
      busy.current = false
      setChecking(false)
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(draft)
      setNotice('Draft copied.')
    } catch { setNotice('Could not copy the draft. Export it instead.') }
  }

  function exportDraft() {
    let url: string | undefined
    try {
      url = URL.createObjectURL(new Blob([draft], { type: 'text/plain;charset=utf-8' }))
      const link = document.createElement('a')
      link.href = url
      link.download = 'cat-code-draft.txt'
      link.click()
      setNotice('Draft export requested.')
    } catch { setNotice('Could not export the draft. Copy it instead.') }
    finally { if (url) setTimeout(() => URL.revokeObjectURL(url!), 0) }
  }

  return <section className="routing-storage-recovery" role="alert" aria-label="Saved message recovery">
    <p>Sending is paused because the saved message file cannot be read. Your current draft has not been sent.</p>
    <p>Copy or export your draft before repairing the file. Keep a backup of the original file and preserve saved message IDs. After repair, check the file again. Messages with uncertain delivery still need review.</p>
    <div className="routing-storage-recovery-actions">
      <button type="button" disabled={!draft} onClick={() => { void copy() }}>Copy draft</button>
      <button type="button" disabled={!draft} onClick={exportDraft}>Export draft</button>
      <button type="button" onClick={() => { void (async () => {
        try { await onInspect() } catch { setNotice('Could not show the saved message file.') }
      })() }}>Show saved message file</button>
      <button type="button" disabled={checking} onClick={() => { void revalidate() }}>{checking ? 'Checking…' : 'Check repaired file'}</button>
    </div>
    {notice ? <p role="status">{notice}</p> : null}
  </section>
}
