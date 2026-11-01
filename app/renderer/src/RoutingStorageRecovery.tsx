import { useEffect, useRef, useState } from 'react'
import type { RoutingStorageHealth } from '../../shared/projectRouting.js'
import './RoutingStorageRecovery.css'

export function RoutingStorageRecovery({ health, draft, draftIdentity = null, onRevalidate, onInspect }: {
  health: RoutingStorageHealth
  draft: string
  draftIdentity?: string | null
  onRevalidate(): Promise<RoutingStorageHealth>
  onInspect(): Promise<void>
}) {
  const busy = useRef(false)
  const [checking, setChecking] = useState(false)
  const [notice, setNotice] = useState('')
  const mounted = useRef(false)
  const currentDraft = useRef({ draft, draftIdentity, generation: Symbol() })
  if (currentDraft.current.draft !== draft || currentDraft.current.draftIdentity !== draftIdentity) {
    currentDraft.current = { draft, draftIdentity, generation: Symbol() }
  }
  const [noticeGeneration, setNoticeGeneration] = useState<symbol | null>(null)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  useEffect(() => {
    setNotice('')
    setNoticeGeneration(null)
  }, [draft, draftIdentity])
  if (health.status === 'healthy') return null

  async function revalidate() {
    if (busy.current) return
    busy.current = true
    setChecking(true)
    setNotice('')
    setNoticeGeneration(null)
    try {
      const result = await onRevalidate()
      if (mounted.current && result.status === 'blocked') setNotice('The saved message file still cannot be read. Sending remains paused.')
    } catch {
      if (mounted.current) setNotice('Could not check the saved message file. Sending remains paused.')
    } finally {
      busy.current = false
      if (mounted.current) setChecking(false)
    }
  }

  async function copy() {
    const generation = currentDraft.current.generation
    const finish = (message: string) => {
      if (!mounted.current || currentDraft.current.generation !== generation) return
      setNoticeGeneration(generation)
      setNotice(message)
    }
    try {
      await navigator.clipboard.writeText(draft)
      finish('Draft copied.')
    } catch { finish('Could not copy the draft. Export it instead.') }
  }

  function exportDraft() {
    setNoticeGeneration(currentDraft.current.generation)
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
        try { await onInspect() } catch { if (mounted.current) { setNoticeGeneration(null); setNotice('Could not show the saved message file.') } }
      })() }}>Show saved message file</button>
      <button type="button" disabled={checking} onClick={() => { void revalidate() }}>{checking ? 'Checking…' : 'Check repaired file'}</button>
    </div>
    {notice && (noticeGeneration === null || noticeGeneration === currentDraft.current.generation) ? <p role="status">{notice}</p> : null}
  </section>
}
