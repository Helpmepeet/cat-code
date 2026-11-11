import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useId } from 'react'
import { createPortal } from 'react-dom'
import { FilePaneFilesContext } from './filePaneFilesContext.js'
import { paneFileIndex, paneFileKey, type PaneFileEntry } from './transcriptPaneFiles.js'
import { selectNestedTranscriptRows, selectTranscriptRows } from './transcriptProjector.js'
import { requestOpenFile, useFilePaneSession } from './filePaneState.js'
import { peekWorkspaceFileAvailability, requestWorkspaceFileAvailability, subscribeWorkspaceFileAvailability } from './workspaceFileAvailabilityQueue.js'
import { filterPaletteItems, type PaletteItem } from './commandPaletteModel.js'
import { useToast } from './toastContext.js'
import { FileTypeIcon } from './FileTypeIcon.js'
import './filePaneFiles.css'

export function FilePaneFiles({ appSessionId, cwd, currentPath }: { appSessionId: string; cwd: string | null; currentPath: string }) {
  const source = useContext(FilePaneFilesContext)
  const pane = useFilePaneSession(appSessionId)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [activeKey, setActiveKey] = useState<string | null>(null)
  const [availabilityRevision, setAvailabilityRevision] = useState(0)
  const trigger = useRef<HTMLButtonElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const listId = useId()
  const toast = useToast()
  const filesRequest = pane.filesRequest
  const previousFilesRequest = useRef(0)
  useEffect(() => {
    const increased = filesRequest > previousFilesRequest.current
    previousFilesRequest.current = filesRequest
    if (!increased) return
    setQuery('')
    setActiveKey(null)
    setOpen(true)
    input.current?.focus()
  }, [filesRequest])
  useEffect(() => open ? subscribeWorkspaceFileAvailability(() => setAvailabilityRevision(value => value + 1)) : undefined, [open])
  const entries = useMemo(() => {
    if (!open) return []
    const transcript = source?.transcript
    return paneFileIndex({ rows: transcript ? selectNestedTranscriptRows(transcript, appSessionId, true) : [],
      order: transcript ? selectTranscriptRows(transcript, appSessionId, true).map(row => row.id) : [],
      cwd: source?.cwd ?? cwd, transitions: source?.contextTransitions, opened: pane.opened,
      available: path => peekWorkspaceFileAvailability(appSessionId, path), includeUnconfirmed: true })
  }, [open, source, appSessionId, cwd, pane.opened, availabilityRevision])
  const filtered = useMemo(() => {
    const confirmed = entries.filter(entry => !entry.weak || entry.availabilityPath && peekWorkspaceFileAvailability(appSessionId, entry.availabilityPath) === true)
    if (!query.trim()) return confirmed.filter(entry => !entry.searchOnly)
    const byKey = new Map(confirmed.map(entry => [entry.key, entry]))
    const items: PaletteItem[] = confirmed.map(entry => ({ id: entry.key, kind: 'file', group: entry.group,
      label: entry.filename, keywords: entry.path, ariaLabel: entry.path, run() {} }))
    return filterPaletteItems(items, query).map(item => byKey.get(item.id)!)
  }, [entries, query, appSessionId])
  const currentKey = paneFileKey(currentPath)
  const activeIndex = Math.max(0, filtered.findIndex(entry => entry.key === activeKey))
  useEffect(() => {
    if (!open || filtered.some(entry => entry.key === activeKey)) return
    setActiveKey((filtered.find(entry => entry.key !== currentKey) ?? filtered[0])?.key ?? null)
  }, [open, filtered, activeKey, currentKey])
  useEffect(() => {
    if (!open) return
    let active = true
    const timers = new Set<ReturnType<typeof setTimeout>>()
    const check = (path: string) => {
      void requestWorkspaceFileAvailability(appSessionId, path, { fresh: true }).then(value => {
        if (active && value === null) {
          const timer = setTimeout(() => { timers.delete(timer); check(path) }, 500)
          timers.add(timer)
        }
      })
    }
    // This opening owns one first-twenty batch, even as missing rows disappear.
    for (const entry of entries.filter(entry => entry.group === 'Mentioned' && !entry.weak && entry.availabilityPath).slice(0, 20)) check(entry.availabilityPath!)
    return () => { active = false; for (const timer of timers) clearTimeout(timer) }
  }, [open, appSessionId])
  const weakPathsKey = JSON.stringify(entries.filter(entry => entry.weak && entry.availabilityPath && peekWorkspaceFileAvailability(appSessionId, entry.availabilityPath) === undefined).map(entry => entry.availabilityPath!))
  useEffect(() => {
    if (!open) return
    let active = true
    const timers = new Set<ReturnType<typeof setTimeout>>()
    const check = (path: string) => {
      void requestWorkspaceFileAvailability(appSessionId, path).then(value => {
        if (active && value === null) {
          const timer = setTimeout(() => { timers.delete(timer); check(path) }, 500)
          timers.add(timer)
        }
      })
    }
    for (const path of JSON.parse(weakPathsKey) as string[]) check(path)
    return () => { active = false; for (const timer of timers) clearTimeout(timer) }
  }, [open, appSessionId, weakPathsKey])
  useLayoutEffect(() => {
    if (!open || !menu.current || !trigger.current) return
    const place = () => {
      const paneBounds = trigger.current!.closest('.file-pane')!.getBoundingClientRect()
      const anchor = trigger.current!.getBoundingClientRect()
      menu.current?.style.setProperty('--files-top', `${anchor.bottom + 5}px`)
      menu.current?.style.setProperty('--files-left', `${Math.max(8, Math.min(paneBounds.left + 8, window.innerWidth - 100))}px`)
      menu.current?.style.setProperty('--files-width', `${Math.max(100, Math.min(420, paneBounds.width - 16))}px`)
      menu.current?.style.setProperty('--files-height', `${Math.max(100, Math.min(paneBounds.height * .6, window.innerHeight - anchor.bottom - 16))}px`)
    }
    place()
    input.current?.focus()
    const observer = new ResizeObserver(place)
    observer.observe(trigger.current.closest('.file-pane')!)
    window.addEventListener('resize', place)
    return () => { observer.disconnect(); window.removeEventListener('resize', place) }
  }, [open])
  useEffect(() => {
    if (!open) return
    menu.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [open, activeKey])
  const close = (focus = true) => { setOpen(false); if (focus) trigger.current?.focus() }
  const choose = (entry: PaneFileEntry, external: boolean) => {
    const promise = entry.external ? window.catcode.openWorkspaceFile(appSessionId, entry.path).then(ok => ok ? { ok: true as const } : { ok: false as const, message: 'Could not open this file' })
      : requestOpenFile(appSessionId, entry.path, { external, focus: 'viewer' })
    close(false)
    void promise.then(result => {
      if (!result.ok) { toast(result.message, { tone: 'warn' }); trigger.current?.focus() }
    }).catch(() => { toast('Could not open this file', { tone: 'warn' }); trigger.current?.focus() })
  }
  return <>
    <button ref={trigger} type="button" className="file-pane-icon" aria-label="Files" title="Files" aria-haspopup="listbox" aria-expanded={open}
      onClick={() => { if (open) close(); else { setQuery(''); setActiveKey(null); setOpen(true) } }}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="M5 3h14v18H5zM8 7h8M8 11h8M8 15h8" /></svg>
    </button>
    {open ? createPortal(<>
      <div className="file-pane-menu-scrim" onMouseDown={() => close()} />
      <div ref={menu} className="file-pane-files" onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close() }
      }}>
        <input ref={input} className="file-pane-files-search" aria-label="Search files" placeholder="Search files" role="combobox" aria-expanded="true" aria-controls={listId}
          aria-activedescendant={filtered[activeIndex] ? `${listId}-${activeIndex}` : undefined} value={query} autoComplete="off" spellCheck={false}
          onChange={event => { setQuery(event.target.value); setActiveKey(null) }} onKeyDown={event => {
            if (event.nativeEvent.isComposing) return
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault(); const count = filtered.length
              if (count) setActiveKey(filtered[(activeIndex + (event.key === 'ArrowDown' ? 1 : count - 1)) % count]!.key)
            } else if (event.key === 'Enter') { event.preventDefault(); if (filtered[activeIndex]) choose(filtered[activeIndex]!, event.metaKey) }
          }} />
        <div id={listId} role="listbox" aria-label="Files" className="file-pane-files-list">
          {filtered.length ? filtered.map((entry, index) => <div key={entry.key}>
            {!query.trim() && (index === 0 || filtered[index - 1]?.group !== entry.group) ? <div className="file-pane-files-group">{entry.group}</div> : null}
            <button id={`${listId}-${index}`} type="button" className="file-pane-file-row" role="option" aria-selected={entry.key === activeKey} aria-current={entry.key === currentKey ? 'true' : undefined} tabIndex={-1}
              title={entry.path} onMouseEnter={() => setActiveKey(entry.key)} onMouseDown={event => event.preventDefault()} onClick={event => choose(entry, event.metaKey)}>
              <FileTypeIcon path={entry.path} renderKind={entry.key === currentKey
                ? pane.file?.kind === 'text' && /\.(?:csv|tsv)$/i.test(entry.path) && pane.scroll.table?.mode !== 'source' && pane.lineTarget === null ? 'table' : pane.file?.kind
                : undefined} />
              <span className="file-pane-file-name">{entry.filename}{entry.external ? <span className="file-pane-file-external" aria-hidden="true"> ↗</span> : null}</span>
              <span className="file-pane-file-parent"><bdi>{entry.parent}</bdi></span>
            </button>
          </div>) : <div className="file-pane-files-empty">{query ? `No files match "${query}"` : 'No files'}</div>}
        </div>
        {source?.transcript.sessions[appSessionId]?.historyTruncated ? <div className="file-pane-files-footer">Files from earlier messages are not listed.</div> : null}
      </div>
    </>, document.body) : null}
  </>
}
