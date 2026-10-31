import { useEffect, useLayoutEffect, useRef, useState, type ComponentPropsWithoutRef } from 'react'
import { createPortal } from 'react-dom'
import { normalizeLocalhostPreviewUrl, localhostPreviewHostPort, type FilePreviewApplications, type FilePreviewDescriptor, type FilePreviewEvent } from '../../shared/filePreview.js'
import type { OpenWorkspaceFileTarget } from '../../shared/protocol.js'
import { captureMarkdownReadingPosition } from './markdownReadingPosition.js'
import { BoundedMarkdown } from './BoundedMarkdown.js'
import { renderMarkdownTree } from './markdownRenderPlan.js'
import { MARKDOWN_COMPONENTS } from './markdownComponents.js'
import { MarkdownCodeBlock } from './MarkdownElements.js'
import { REHYPE_PLUGINS } from './markdownPlugins.js'
import { FilePathActionsMenu } from './FilePathActionsMenu.js'
import type { FilePathActionsAnchor } from './filePathActions.js'
import { ExternalAppIcon } from './ExternalAppIcon.js'
import { ActionCheckIcon, ActionChevronIcon, ActionCloseIcon, ActionCopyIcon } from './SessionActionIcons.js'
import { useToast } from './toastContext.js'
import {
  closeFilePane, getFilePaneSession, registerFilePaneScroll, rememberFilePaneScroll,
  isPaneFilePath, paneTargetLabel, previewDescriptorNote, recordLocalhostRoute, samePaneRevision, rejectFilePaneCandidate, requestOpenFile, stepFilePaneHistory, updateFilePaneSession, useFilePaneSession, type FilePaneScroll,
} from './filePaneState.js'
import './filePane.css'

type PaintedFile = { descriptor: FilePreviewDescriptor; key: string }
export function FilePane({ appSessionId, cwd, onFocusComposer }: {
  appSessionId: string
  cwd: string | null
  onFocusComposer?: () => void
}) {
  const state = useFilePaneSession(appSessionId)
  const descriptor = state.file
  const [painted, setPainted] = useState<PaintedFile | null>(null)
  const [previewHydrated, setPreviewHydrated] = useState(!descriptor)
  const hydrationRequest = useRef<{ id: string; promise: Promise<FilePreviewDescriptor | null> } | null>(null)
  const [committing, setCommitting] = useState<PaintedFile | null>(null)
  const committingRef = useRef<PaintedFile | null>(null)
  const readyKeys = useRef(new Set<string>())
  const [reload, setReload] = useState(0)
  const [apps, setApps] = useState<FilePreviewApplications | null>(null)
  const [appMenu, setAppMenu] = useState(false)
  const [pathMenu, setPathMenu] = useState<FilePathActionsAnchor | null>(null)
  const [copied, setCopied] = useState(false)
  const [pathScrollable, setPathScrollable] = useState(false)
  const [pathDragging, setPathDragging] = useState(false)
  const appChoice = useRef(0)
  const menuRef = useRef<HTMLDivElement>(null)
  const appTrigger = useRef<HTMLButtonElement>(null)
  const headerPath = useRef<HTMLDivElement>(null)
  const pathScroll = useRef<HTMLSpanElement>(null)
  const activeBody = useRef<HTMLDivElement>(null)
  const mounted = useRef(true)
  const paintedRef = useRef(painted)
  const descriptorRef = useRef(descriptor)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const feedbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const drag = useRef<{ pointerId: number; x: number; y: number; left: number; moved: boolean; scrolling: boolean } | null>(null)
  const toast = useToast()
  paintedRef.current = painted
  descriptorRef.current = descriptor
  const stagingDescriptor = !painted && state.committedFile && descriptor?.kind !== 'localhost' ? state.committedFile : descriptor
  const candidateKey = stagingDescriptor ? `${stagingDescriptor.id}:${stagingDescriptor.revision}:${stagingDescriptor.url}:${reload}` : ''
  const retainCommit = committing && descriptor?.id === committing.descriptor.id &&
    (descriptor.kind === 'localhost' || descriptor.path === committing.descriptor.path) && descriptor.revision >= committing.descriptor.revision
  const candidate = !previewHydrated ? null : retainCommit ? committing : stagingDescriptor && painted?.key !== candidateKey ? { descriptor: stagingDescriptor, key: candidateKey } : null
  useLayoutEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  useLayoutEffect(() => {
    const element = pathScroll.current
    if (!element) return
    let previousMax = 0
    const measure = () => {
      const max = Math.max(0, element.scrollWidth - element.clientWidth)
      const atEnd = element.scrollLeft >= Math.min(previousMax, max) - 1
      setPathScrollable(max > 0)
      if (atEnd) element.scrollLeft = max
      previousMax = max
    }
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(element)
    if (element.firstElementChild) observer?.observe(element.firstElementChild)
    return () => observer?.disconnect()
  }, [descriptor?.path])

  const readScroll = async (): Promise<FilePaneScroll> => {
    const showing = paintedRef.current?.descriptor
    if (!showing) return getFilePaneSession(appSessionId).scroll
    if (showing.kind === 'html' || showing.kind === 'svg' || showing.kind === 'localhost') {
      try { return await window.catcode.readFilePreviewScroll(showing.id, showing.revision) } catch { return getFilePaneSession(appSessionId).scroll }
    }
    if (showing.kind === 'markdown' && activeBody.current?.clientHeight === 0) return getFilePaneSession(appSessionId).scroll
    return activeBody.current ? { x: activeBody.current.scrollLeft, y: activeBody.current.scrollTop, ...(showing.kind === 'markdown' ? { markdown: captureMarkdownReadingPosition(activeBody.current) } : {}) } : getFilePaneSession(appSessionId).scroll
  }
  useEffect(() => registerFilePaneScroll(appSessionId, () => {
    const current = getFilePaneSession(appSessionId)
    const showing = paintedRef.current?.descriptor
    return samePaneRevision(current.file, showing) && current.file?.path === showing?.path && current.file?.routeKey === showing?.routeKey
      ? readScroll() : Promise.resolve(current.scroll)
  }), [appSessionId])
  useEffect(() => {
    const timer = setInterval(() => {
      const showing = paintedRef.current?.descriptor
      if (showing?.kind === 'html' || showing?.kind === 'svg' || showing?.kind === 'localhost') void readScroll().then(scroll => rememberFilePaneScroll(appSessionId, scroll, showing))
    }, 250)
    return () => clearInterval(timer)
  }, [appSessionId])
  useEffect(() => () => {
    if (copyTimer.current) clearTimeout(copyTimer.current)
    if (feedbackTimer.current) clearTimeout(feedbackTimer.current)
    const showing = paintedRef.current?.descriptor
    void readScroll().then(scroll => rememberFilePaneScroll(appSessionId, scroll, showing))
  }, [appSessionId])

  useEffect(() => {
    if (!descriptor) return
    let current = true
    const choice = ++appChoice.current
    void window.catcode.getFilePreviewApplications(appSessionId, descriptor.path)
      .then(value => { if (current && choice === appChoice.current) setApps(value) }).catch(() => { if (current && choice === appChoice.current) setApps(null) })
    return () => { current = false }
  }, [appSessionId, descriptor?.path])

  useEffect(() => {
    if (!descriptor) return
    let current = true
    // The frame is destroyed when its session leaves the screen. The host's
    // bounded snapshot remains available, including after a file was removed.
    // Even an uncommitted first-load snapshot can miss updates while off-screen.
    // StrictMode's effect replay must await the same catch-up read.
    const pending = hydrationRequest.current?.id === descriptor.id
      ? hydrationRequest.current.promise : window.catcode.refreshFilePreview(descriptor.id)
    hydrationRequest.current = { id: descriptor.id, promise: pending }
    void pending.then(next => {
      if (current && next && descriptorRef.current?.id === next.id && !olderThanRetainedRevision(appSessionId, next) && (!samePaneRevision(next, descriptorRef.current) || next.serverStopped !== descriptorRef.current.serverStopped || next.blockedHost !== descriptorRef.current.blockedHost || next.browserNote !== descriptorRef.current.browserNote || next.watchError !== descriptorRef.current.watchError)) {
        updateFilePaneSession(appSessionId, { file: next, note: previewDescriptorNote(next) })
      }
    }).catch(() => {}).finally(() => { if (current && mounted.current) setPreviewHydrated(true) })
    return () => { current = false }
  }, [appSessionId])

  useEffect(() => window.catcode.subscribeFilePreview(event => {
    const current = descriptorRef.current
    if (!current) return
    if (event.kind === 'key') {
      if (event.id !== current.id && event.id !== paintedRef.current?.descriptor.id) return
      if (event.key === 'Escape') { closeFilePane(appSessionId); onFocusComposer?.(); return }
      document.dispatchEvent(new KeyboardEvent('keydown', {
        key: event.key, code: event.code, metaKey: event.metaKey, shiftKey: event.shiftKey,
        altKey: event.altKey, ctrlKey: event.ctrlKey, bubbles: true, cancelable: true,
      }))
      return
    }
    // A failed navigation can return to the page still painted underneath it.
    // Keep that page's status while the incoming page owns the visible header.
    const retained = getFilePaneSession(appSessionId)
    if (event.kind === 'updated' && olderThanRetainedRevision(appSessionId, event.descriptor)) return
    const status = retainedStatus(event)
    if (status !== undefined) {
      const checkpoint = retained.checkpoint
      const appliesToCheckpoint = checkpoint?.file?.id === event.id || checkpoint?.committedFile?.id === event.id
      const metadata = (file: FilePreviewDescriptor | null) => {
        if (!file || file.id !== event.id) return file
        if (event.kind === 'updated') return { ...file, watchError: event.descriptor.watchError, serverStopped: event.descriptor.serverStopped, blockedHost: event.descriptor.blockedHost, browserNote: file.path === event.descriptor.path ? event.descriptor.browserNote : file.browserNote }
        if (event.kind === 'watch-error') return { ...file, watchError: true }
        if (event.kind === 'server-stopped') return { ...file, serverStopped: true }
        if (event.kind === 'leave') return { ...file, blockedHost: event.host }
        if (event.kind === 'browser-note' && file.path === event.path) return { ...file, browserNote: event.note }
        return file
      }
      if (appliesToCheckpoint || retained.committedFile?.id === event.id) updateFilePaneSession(appSessionId, {
        committedFile: metadata(retained.committedFile),
        ...(appliesToCheckpoint && checkpoint ? { checkpoint: { ...checkpoint, note: event.kind === 'browser-note' ? previewDescriptorNote(metadata(checkpoint.file)) : status,
          file: event.kind === 'updated' && checkpoint.file?.id === event.id ? event.descriptor : metadata(checkpoint.file),
          committedFile: metadata(checkpoint.committedFile),
        } } : {}),
      })
    }
    if (event.id !== current.id) return
    if (event.kind === 'updated') updateFilePaneSession(appSessionId, { file: event.descriptor, note: previewDescriptorNote(event.descriptor) })
    else if (event.kind === 'removed' || event.kind === 'watch-error' || event.kind === 'update-error') updateFilePaneSession(appSessionId, { note: event.kind })
    else if (event.kind === 'route') recordLocalhostRoute(appSessionId, event.url, event.scroll, event.routeKey, event.replace, event.browserNote)
    else if (event.kind === 'browser-note' && current.path === event.path) {
      const file = { ...current, browserNote: event.note }
      updateFilePaneSession(appSessionId, { file, note: previewDescriptorNote(file) })
    }
    else if (event.kind === 'server-stopped' || event.kind === 'leave') {
      const file = { ...current, ...(event.kind === 'server-stopped' ? { serverStopped: true } : { blockedHost: event.host }) }
      const committed = getFilePaneSession(appSessionId).committedFile
      updateFilePaneSession(appSessionId, { file,
        ...(committed?.id === file.id ? { committedFile: { ...committed, ...(event.kind === 'server-stopped' ? { serverStopped: true } : { blockedHost: event.host }) } } : {}),
        note: event.kind === 'server-stopped' ? 'server-stopped' : 'leave' })
    }
    else if (event.kind === 'navigate') {
      void requestOpenFile(appSessionId, event.path, { source: event.source }).then(result => { if (!result.ok) toast(result.message, { tone: 'warn' }) })
    }
  }), [appSessionId, toast, onFocusComposer])

  useEffect(() => {
    if (descriptor?.kind !== 'localhost') return
    setPainted(previous => previous && samePaneRevision(previous.descriptor, descriptor) &&
      (previous.descriptor.path !== descriptor.path || previous.descriptor.routeKey !== descriptor.routeKey)
      ? { ...previous, descriptor } : previous)
  }, [descriptor?.path, descriptor?.routeKey, descriptor?.id, descriptor?.revision])

  useLayoutEffect(() => {
    if (!appMenu || !menuRef.current || !appTrigger.current) return
    const box = appTrigger.current.getBoundingClientRect()
    menuRef.current.style.setProperty('--file-menu-top', `${box.bottom + 5}px`)
    menuRef.current.style.setProperty('--file-menu-left', `${Math.max(8, Math.min(window.innerWidth - 252, box.right - 244))}px`)
    menuRef.current.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus()
  }, [appMenu])

  const failed = (next: PaintedFile) => {
    if (!mounted.current) return
    const stopped = getFilePaneSession(appSessionId).note === 'server-stopped'
    if (rejectFilePaneCandidate(appSessionId, next.descriptor)) toast(next.descriptor.kind === 'localhost'
      ? stopped ? `Nothing is running at ${localhostPreviewHostPort(next.descriptor.path)}` : 'Could not open this page'
      : 'Could not open this file', { tone: 'warn' })
  }
  const ready = async (next: PaintedFile, restoredScroll?: FilePaneScroll) => {
    const current = getFilePaneSession(appSessionId)
    const restoringCommitted = !paintedRef.current && samePaneRevision(current.committedFile, next.descriptor)
    if (!mounted.current || !current.open || readyKeys.current.has(next.key) ||
      !samePaneRevision(descriptorRef.current, next.descriptor) && !restoringCommitted) return
    readyKeys.current.add(next.key)
    committingRef.current = next
    setCommitting(next)
    try {
      const previous = paintedRef.current
      const replacingSameFile = previous?.descriptor.path === next.descriptor.path || next.descriptor.kind === 'localhost' && previous?.descriptor.id === next.descriptor.id
      const scroll = restoredScroll ?? (replacingSameFile ? await readScroll() : getFilePaneSession(appSessionId).scroll)
      if (!restoringCommitted && !await window.catcode.commitFilePreview(next.descriptor.id, next.descriptor.revision)) {
        failed(next)
        return
      }
      if (next.descriptor.kind === 'html' || next.descriptor.kind === 'svg' || next.descriptor.kind === 'localhost') {
        await window.catcode.restoreFilePreviewScroll(next.descriptor.id, next.descriptor.revision, { x: scroll.x, y: scroll.y })
      }
      const latest = getFilePaneSession(appSessionId)
      const queuedRevision = latest.file?.id === next.descriptor.id && (latest.file.kind === 'localhost' || latest.file.path === next.descriptor.path) &&
        latest.file.revision > next.descriptor.revision
      const newerCommitted = latest.committedFile?.id === next.descriptor.id && latest.committedFile.revision > next.descriptor.revision
      if (!mounted.current || !latest.open || newerCommitted || !samePaneRevision(descriptorRef.current, next.descriptor) && !queuedRevision &&
        !(restoringCommitted && samePaneRevision(latest.committedFile, next.descriptor))) return
      const published = samePaneRevision(latest.file, next.descriptor) ? latest.file! : next.descriptor
      if (!restoringCommitted) updateFilePaneSession(appSessionId, { committedFile: published, checkpoint: null })
      rememberFilePaneScroll(appSessionId, scroll, published)
      setPainted({ ...next, descriptor: published })
      if (previous && previous.descriptor.id !== next.descriptor.id) window.catcode.releaseFilePreview(previous.descriptor.id)
    } catch { return }
    finally {
      readyKeys.current.delete(next.key)
      if (committingRef.current?.key === next.key) {
        committingRef.current = null
        if (mounted.current) setCommitting(null)
      }
    }
  }
  useLayoutEffect(() => {
    if (!painted || painted.descriptor.kind === 'markdown' || !activeBody.current) return
    const scroll = getFilePaneSession(appSessionId).scroll
    activeBody.current.scrollLeft = scroll.x
    activeBody.current.scrollTop = scroll.y
  }, [painted, appSessionId])

  if (!descriptor) return null
  const isLocalhost = descriptor.kind === 'localhost'
  const name = paneTargetLabel(descriptor.path)
  const displayed = isLocalhost ? descriptor.path : descriptor.displayPath
  const split = isLocalhost ? 'http://'.length : displayed.lastIndexOf('/') + 1
  const selected = apps?.selected ?? (isLocalhost ? 'chrome' : 'default')
  const selectedLabel = apps?.applications.find(app => app.target === selected)?.label ?? (isLocalhost ? 'Google Chrome' : 'Default application')
  const openApp = async (target: OpenWorkspaceFileTarget, path = descriptor.path) => {
    setAppMenu(false)
    const choice = ++appChoice.current
    const isCurrentChoice = () => mounted.current && choice === appChoice.current && samePaneRevision(descriptorRef.current, descriptor) &&
      descriptorRef.current?.path === descriptor.path && descriptorRef.current?.routeKey === descriptor.routeKey
    try {
      const opened = await window.catcode.chooseFilePreviewApplication(appSessionId, path, target)
      if (!isCurrentChoice()) return
      if (!opened) toast(isLocalhost ? 'Could not open this page' : 'Could not open this file', { tone: 'warn' })
      else if (target !== 'finder') setApps(current => current ? { ...current, selected: target } : current)
    } catch { if (isCurrentChoice()) toast(isLocalhost ? 'Could not open this page' : 'Could not open this file', { tone: 'warn' }) }
  }
  const copyPath = () => {
    void navigator.clipboard?.writeText(descriptor.path).then(() => {
      setCopied(true)
      if (feedbackTimer.current) clearTimeout(feedbackTimer.current)
      feedbackTimer.current = setTimeout(() => setCopied(false), 1400)
    }).catch(() => {})
  }
  const selectedPathText = () => {
    const selection = window.getSelection()
    return !!selection && !selection.isCollapsed && !!(headerPath.current?.contains(selection.anchorNode) || headerPath.current?.contains(selection.focusNode))
  }
  const reloadFile = async () => {
    try {
      const next = await window.catcode.refreshFilePreview(descriptor.id)
      if (next && getFilePaneSession(appSessionId).file?.id === next.id && !olderThanRetainedRevision(appSessionId, next)) {
        updateFilePaneSession(appSessionId, { file: next, note: previewDescriptorNote(next) }); setReload(value => value + 1)
      }
    } catch { updateFilePaneSession(appSessionId, { note: isLocalhost ? 'server-stopped' : 'watch-error' }) }
  }
  return <aside className="file-pane" aria-label={`File preview: ${name}`} onKeyDown={event => {
    if (event.key === 'Escape' && !event.defaultPrevented && !pathMenu && !appMenu) { event.preventDefault(); event.stopPropagation(); closeFilePane(appSessionId); onFocusComposer?.() }
  }}>
    <header className="file-pane-header">
      <button type="button" className="file-pane-icon" aria-label="Back" title="Back" disabled={!state.history.length}
        onClick={() => { void stepFilePaneHistory(appSessionId, 'back').then(result => { if (!result.ok) toast(result.message, { tone: 'warn' }) }) }}><PaneArrow back /></button>
      <button type="button" className="file-pane-icon" aria-label="Forward" title="Forward" disabled={!state.forward.length}
        onClick={() => { void stepFilePaneHistory(appSessionId, 'forward').then(result => { if (!result.ok) toast(result.message, { tone: 'warn' }) }) }}><PaneArrow /></button>
      <button type="button" className="file-pane-icon" aria-label="Reload" title="Reload" onClick={() => { void reloadFile() }}><ReloadIcon /></button>
      <div ref={headerPath} className="file-pane-path" tabIndex={0} role="button" title={descriptor.path}
        data-scrollable={pathScrollable || undefined} data-dragging={pathDragging || undefined}
        aria-description={pathScrollable ? 'Drag or use arrow keys to scroll the path. Hold Shift to select text.' : undefined}
        onPointerDown={event => {
          if (event.button !== 0 || !event.isPrimary) return
          if (copyTimer.current) clearTimeout(copyTimer.current)
          const element = pathScroll.current
          const scrolling = !!element && element.scrollWidth > element.clientWidth && event.pointerType !== 'touch' &&
            !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey && !selectedPathText()
          drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, left: element?.scrollLeft ?? 0, moved: false, scrolling }
          if (!scrolling) return
          event.preventDefault()
          event.currentTarget.focus({ preventScroll: true })
          event.currentTarget.setPointerCapture(event.pointerId)
        }}
        onPointerMove={event => {
          const current = drag.current
          if (!current || current.pointerId !== event.pointerId) return
          if (Math.abs(event.clientX - current.x) + Math.abs(event.clientY - current.y) <= 3) return
          current.moved = true
          if (!current.scrolling || !pathScroll.current) return
          event.preventDefault()
          setPathDragging(true)
          pathScroll.current.scrollLeft = current.left - (event.clientX - current.x)
        }}
        onPointerUp={event => {
          if (drag.current?.pointerId !== event.pointerId) return
          drag.current.scrolling = false
          setPathDragging(false)
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
        }}
        onPointerCancel={event => {
          if (drag.current?.pointerId !== event.pointerId) return
          drag.current.moved = true
          drag.current.scrolling = false
          setPathDragging(false)
        }}
        onLostPointerCapture={() => {
          if (drag.current) drag.current.scrolling = false
          setPathDragging(false)
        }}
        onClick={event => {
          if (copyTimer.current) clearTimeout(copyTimer.current)
          if (drag.current?.moved) return
          if (event.metaKey) { void openApp(selected); return }
          if (event.detail > 1 || selectedPathText()) return
          copyTimer.current = setTimeout(copyPath, 220)
        }}
        onKeyDown={event => {
          if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); copyPath(); return }
          const element = pathScroll.current
          if (!element || !pathScrollable || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
          event.preventDefault()
          event.stopPropagation()
          element.scrollLeft = event.key === 'Home' ? 0 : event.key === 'End' ? element.scrollWidth
            : element.scrollLeft + (event.key === 'ArrowLeft' ? -48 : 48)
        }}
        onCopy={event => { const text = window.getSelection()?.toString(); if (text) { event.preventDefault(); event.clipboardData.setData('text/plain', text.replace(/[\r\n]+$/, '')) } }}
        onContextMenu={event => { if (isLocalhost || selectedPathText()) return; event.preventDefault(); setPathMenu({ type: 'pointer', x: event.clientX, y: event.clientY }) }}>
        <span ref={pathScroll} className="file-pane-path-text"><bdi dir="ltr"><span className="file-pane-folder">{displayed.slice(0, split)}</span>{displayed.slice(split)}</bdi></span>
      </div>
      <button type="button" className="file-pane-copy" aria-label="Copy full path" title="Copy full path" data-copied={copied || undefined}
        onClick={copyPath}>{copied ? <ActionCheckIcon /> : <ActionCopyIcon />}</button>
      <div className="file-pane-app-split">
        <button type="button" className="file-pane-open-app" title={`Open in ${selectedLabel}`} aria-label={`Open in ${selectedLabel}`} onClick={() => { void openApp(selected) }}>
          <ExternalAppIcon request={selected === 'default' ? { target: selected, appSessionId, path: descriptor.path } : { target: selected }} />
        </button>
        <button ref={appTrigger} type="button" className="file-pane-choose-app" aria-label="Choose an app" aria-haspopup="menu" aria-expanded={appMenu} onClick={() => setAppMenu(value => !value)}><ActionChevronIcon /></button>
      </div>
      <button type="button" className="file-pane-icon" aria-label="Close file" title="Close  ⇧⌘B" onClick={() => { closeFilePane(appSessionId); onFocusComposer?.() }}><ActionCloseIcon /></button>
    </header>
    {state.note ? <div className="file-pane-note" role="status"><span>{state.note === 'server-stopped' ? 'The server stopped. Showing the last version.'
      : state.note === 'leave' ? `This page wants to open ${descriptor.blockedHost ?? ''}`
      : state.note === 'browser-required' ? 'This page needs a browser to continue.'
      : state.note === 'frame-blocked' ? 'Part of this page can only show in a browser.'
      : state.note === 'removed' ? `${name} was removed. Showing the last version.`
      : state.note === 'watch-error' ? 'File watching stopped. Showing the last version.' : 'Could not update this file. Showing the last version.'}</span>
      {(state.note === 'leave' || state.note === 'browser-required' || state.note === 'frame-blocked') && isLocalhost ? <button type="button" className="file-pane-note-action" onClick={() => {
        if (state.note !== 'leave') { void openApp(selected, state.committedFile?.path ?? descriptor.path); return }
        void window.catcode.openBlockedPreviewNavigation(descriptor.id, selected === 'safari' ? 'safari' : 'chrome').then(opened => {
          if (opened) {
            const current = getFilePaneSession(appSessionId)
            if (current.file?.id === descriptor.id) {
              const file = { ...current.file, blockedHost: undefined }
              updateFilePaneSession(appSessionId, { file, ...(samePaneRevision(current.committedFile, file) ? { committedFile: file } : {}), note: previewDescriptorNote(file) })
            }
          } else toast('Could not open this page', { tone: 'warn' })
        }).catch(() => toast('Could not open this page', { tone: 'warn' }))
      }}>Open in {selectedLabel}</button> : null}
    </div> : null}
    <div className="file-pane-host">
      {painted ? <FileContent key={painted.key} file={painted.descriptor} active bodyRef={activeBody} appSessionId={appSessionId} /> : null}
      {candidate ? <FileContent key={candidate.key} file={candidate.descriptor} active={false} appSessionId={appSessionId} onReady={scroll => { void ready(candidate, scroll) }} onFailure={() => failed(candidate)} /> : null}
    </div>
    {pathMenu ? <FilePathActionsMenu anchor={pathMenu} rawPath={descriptor.path} cwd={cwd} sessionId={appSessionId} onClose={() => setPathMenu(null)} /> : null}
    {appMenu ? createPortal(<>
      <div className="file-pane-menu-scrim" onClick={() => setAppMenu(false)} />
      <div ref={menuRef} className="file-pane-app-menu" role="menu" aria-label="Open file in" onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setAppMenu(false); appTrigger.current?.focus() }
        else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault()
          const rows = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])]
          const index = rows.indexOf(document.activeElement as HTMLButtonElement)
          rows[(index + (event.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length]?.focus()
        }
      }}>
        {apps?.applications.filter(app => app.target !== 'finder').map(app => <button key={app.target} type="button" className="file-pane-app-row" role="menuitem" onClick={() => { void openApp(app.target) }}>
          <ExternalAppIcon request={app.target === 'default' ? { target: app.target, appSessionId, path: descriptor.path } : { target: app.target }} />
          <span>{app.label}</span>{selected === app.target ? <ActionCheckIcon /> : null}
        </button>)}
        {!isLocalhost ? <><div className="file-pane-menu-seam" />
        <button type="button" className="file-pane-app-row" role="menuitem" onClick={() => { void openApp('finder') }}><ExternalAppIcon request={{ target: 'finder' }} /><span>Reveal in Finder</span></button></> : null}
      </div>
    </>, document.body) : null}
  </aside>
}

function FileContent({ file, active, bodyRef, appSessionId, onReady, onFailure }: {
  file: FilePreviewDescriptor
  active: boolean
  bodyRef?: React.RefObject<HTMLDivElement | null>
  appSessionId: string
  onReady?: (scroll?: FilePaneScroll) => void
  onFailure?: () => void
}) {
  const scrollElement = useRef<HTMLDivElement>(null)
  const initialScroll = useRef(getFilePaneSession(appSessionId).scroll)
  const readMarkdownScroll = (): FilePaneScroll | undefined => {
    const element = scrollElement.current
    if (!element) return
    if (element.clientHeight === 0) return initialScroll.current
    return {
      x: element.scrollLeft, y: element.scrollTop,
      markdown: captureMarkdownReadingPosition(element) ?? initialScroll.current.markdown,
    }
  }
  const ready = useRef(onReady)
  ready.current = onReady
  useEffect(() => {
    if (file.kind !== 'markdown' || active) return
    if (scrollElement.current) scrollElement.current.scrollLeft = initialScroll.current.x
    let frame = requestAnimationFrame(() => { frame = requestAnimationFrame(() => ready.current?.(readMarkdownScroll())) })
    return () => cancelAnimationFrame(frame)
  }, [file.url, file.kind, active])
  const toast = useToast()
  const loaded = () => { requestAnimationFrame(() => requestAnimationFrame(() => ready.current?.())) }
  const className = `file-pane-content${active ? '' : ' file-pane-staging'}`
  if (file.kind === 'html' || file.kind === 'svg' || file.kind === 'localhost') return <iframe className={className} src={file.url} name={file.frameName} title={paneTargetLabel(file.path)}
    sandbox={file.kind === 'localhost' ? 'allow-scripts allow-same-origin allow-forms allow-popups' : 'allow-scripts allow-same-origin'} onLoad={loaded} />
  if (file.kind === 'image') return <div ref={bodyRef} className={`${className} file-pane-image`}><img src={file.url} alt={file.path.split('/').at(-1)} onLoad={loaded} onError={onFailure} draggable={false} /></div>
  const openLocal = (href: string, external = false) => {
    const path = href.startsWith('/') ? href : `${file.path.slice(0, file.path.lastIndexOf('/') + 1)}${href}`
    const opening = isPaneFilePath(path) ? requestOpenFile(appSessionId, path, { external }) : window.catcode.openWorkspaceFile(appSessionId, path).then(ok => ok ? { ok: true as const } : { ok: false as const, message: 'Could not open this file' })
    void opening.then(result => { if (!result.ok) toast(result.message, { tone: 'warn' }) })
      .catch(() => toast('Could not open this file', { tone: 'warn' }))
  }
  const Anchor = ({ href, children }: ComponentPropsWithoutRef<'a'>) => {
    if (!href) return <span>{children}</span>
    if (normalizeLocalhostPreviewUrl(href)) return <button className="file-pane-markdown-link" type="button" onClick={event => { void requestOpenFile(appSessionId, href, { external: event.metaKey }).then(result => { if (!result.ok) toast(result.message, { tone: 'warn' }) }) }}>{children}</button>
    if (/^[a-z][a-z\d+.-]*:/i.test(href) || href.startsWith('//')) return <a href={href} target="_blank" rel="noreferrer">{children}</a>
    if (href.startsWith('#')) return <a href={href} onClick={event => {
      event.preventDefault(); document.getElementById(href.slice(1))?.scrollIntoView()
    }}>{children}</a>
    return <button className="file-pane-markdown-link" type="button" onClick={event => {
      let path = href
      try { path = decodeURIComponent(href) } catch { /* Keep a literal percent in the filename. */ }
      openLocal(path, event.metaKey)
    }}>{children}</button>
  }
  const Image = ({ src, alt }: ComponentPropsWithoutRef<'img'>) => {
    const source = typeof src === 'string' ? src : ''
    let resolved = source
    try { resolved = new URL(source, file.url).href } catch { /* Keep a malformed source inert. */ }
    return <img src={resolved} alt={alt ?? ''} />
  }
  return <div ref={element => {
    scrollElement.current = element
    if (bodyRef) bodyRef.current = element
  }} className={`${className} file-pane-markdown`} tabIndex={active ? 0 : -1}
    onScroll={event => { if (active) rememberFilePaneScroll(appSessionId, { x: event.currentTarget.scrollLeft, y: event.currentTarget.scrollTop, markdown: captureMarkdownReadingPosition(event.currentTarget) }, file) }}>
    <div className="file-pane-markdown-column">
      <BoundedMarkdown sourceId={`file:${file.path}`} source={file.markdown ?? ''} scrollContainerRef={scrollElement}
        rehypePlugins={REHYPE_PLUGINS} recognizeCallouts
        initialReadingPosition={initialScroll.current.markdown} initialScrollOffset={initialScroll.current.y} renderLeaf={leaf =>
        <div className="md-prose">{leaf.kind === 'code'
          ? <MarkdownCodeBlock code={leaf.codeSource} language={leaf.codeLanguage} windowed
              highlighted={renderMarkdownTree(leaf.content)} />
          : renderMarkdownTree(leaf.tree, { ...MARKDOWN_COMPONENTS, a: Anchor, img: Image })}</div>} />
    </div>
  </div>
}
function PaneArrow({ back = false }: { back?: boolean }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d={back ? 'M20 12H4m7-7-7 7 7 7' : 'M4 12h16m-7-7 7 7-7 7'} /></svg>
}
function ReloadIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6" /></svg>
}

function retainedStatus(event: FilePreviewEvent): ReturnType<typeof previewDescriptorNote> | undefined {
  if (event.kind === 'updated') return previewDescriptorNote(event.descriptor)
  if (event.kind === 'removed' || event.kind === 'watch-error' || event.kind === 'update-error' || event.kind === 'server-stopped') return event.kind
  if (event.kind === 'leave') return 'leave'
  if (event.kind === 'browser-note') return event.note
  return undefined
}

function olderThanRetainedRevision(appSessionId: string, incoming: FilePreviewDescriptor): boolean {
  const state = getFilePaneSession(appSessionId)
  return [state.file, state.committedFile, state.checkpoint?.file, state.checkpoint?.committedFile]
    .some(file => file?.id === incoming.id && file.revision > incoming.revision)
}
