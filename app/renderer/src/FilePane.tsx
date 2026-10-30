import { useEffect, useLayoutEffect, useRef, useState, type ComponentPropsWithoutRef } from 'react'
import { createPortal } from 'react-dom'
import type { FilePreviewApplications, FilePreviewDescriptor } from '../../shared/filePreview.js'
import type { OpenWorkspaceFileTarget } from '../../shared/protocol.js'
import { captureMarkdownReadingPosition } from './markdownReadingPosition.js'
import { BoundedMarkdown } from './BoundedMarkdown.js'
import { renderMarkdownTree } from './markdownRenderPlan.js'
import { FilePathActionsMenu } from './FilePathActionsMenu.js'
import type { FilePathActionsAnchor } from './filePathActions.js'
import { ExternalAppIcon } from './ExternalAppIcon.js'
import { ActionCheckIcon, ActionChevronIcon, ActionCloseIcon, ActionCopyIcon } from './SessionActionIcons.js'
import { useToast } from './toastContext.js'
import {
  closeFilePane, getFilePaneSession, registerFilePaneScroll, rememberFilePaneScroll,
  isPaneFilePath, rejectFilePaneCandidate, requestOpenFile, stepFilePaneHistory, updateFilePaneSession, useFilePaneSession, type FilePaneScroll,
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
  const [committing, setCommitting] = useState<PaintedFile | null>(null)
  const committingRef = useRef<PaintedFile | null>(null)
  const readyKeys = useRef(new Set<string>())
  const [reload, setReload] = useState(0)
  const [apps, setApps] = useState<FilePreviewApplications | null>(null)
  const [appMenu, setAppMenu] = useState(false)
  const [pathMenu, setPathMenu] = useState<FilePathActionsAnchor | null>(null)
  const [copied, setCopied] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const appTrigger = useRef<HTMLButtonElement>(null)
  const headerPath = useRef<HTMLDivElement>(null)
  const activeBody = useRef<HTMLDivElement>(null)
  const mounted = useRef(true)
  const paintedRef = useRef(painted)
  const descriptorRef = useRef(descriptor)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const feedbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null)
  const toast = useToast()
  paintedRef.current = painted
  descriptorRef.current = descriptor
  const stagingDescriptor = !painted && state.committedFile ? state.committedFile : descriptor
  const candidateKey = stagingDescriptor ? `${stagingDescriptor.url}:${reload}` : ''
  const retainCommit = committing && descriptor?.id === committing.descriptor.id &&
    descriptor.path === committing.descriptor.path && descriptor.revision >= committing.descriptor.revision
  const candidate = retainCommit ? committing : stagingDescriptor && painted?.key !== candidateKey ? { descriptor: stagingDescriptor, key: candidateKey } : null
  useLayoutEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const readScroll = async (): Promise<FilePaneScroll> => {
    const showing = paintedRef.current?.descriptor
    if (!showing) return getFilePaneSession(appSessionId).scroll
    if (showing.kind === 'html' || showing.kind === 'svg') {
      try { return await window.catcode.readFilePreviewScroll(showing.id, showing.revision) } catch { return getFilePaneSession(appSessionId).scroll }
    }
    if (showing.kind === 'markdown' && activeBody.current?.clientHeight === 0) return getFilePaneSession(appSessionId).scroll
    return activeBody.current ? { x: activeBody.current.scrollLeft, y: activeBody.current.scrollTop, ...(showing.kind === 'markdown' ? { markdown: captureMarkdownReadingPosition(activeBody.current) } : {}) } : getFilePaneSession(appSessionId).scroll
  }
  useEffect(() => registerFilePaneScroll(appSessionId, readScroll), [appSessionId])
  useEffect(() => {
    const timer = setInterval(() => {
      const showing = paintedRef.current?.descriptor
      if (showing?.kind === 'html' || showing?.kind === 'svg') void readScroll().then(scroll => rememberFilePaneScroll(appSessionId, scroll))
    }, 250)
    return () => clearInterval(timer)
  }, [appSessionId])
  useEffect(() => () => {
    if (copyTimer.current) clearTimeout(copyTimer.current)
    if (feedbackTimer.current) clearTimeout(feedbackTimer.current)
    void readScroll().then(scroll => rememberFilePaneScroll(appSessionId, scroll))
  }, [appSessionId])

  useEffect(() => {
    if (!descriptor) return
    let current = true
    void window.catcode.getFilePreviewApplications(appSessionId, descriptor.path)
      .then(value => { if (current) setApps(value) }).catch(() => { if (current) setApps(null) })
    return () => { current = false }
  }, [appSessionId, descriptor?.path])

  useEffect(() => {
    if (!descriptor || !getFilePaneSession(appSessionId).committedFile) return
    // The frame is destroyed when its session leaves the screen. The host's
    // bounded snapshot remains available, including after a file was removed.
    void window.catcode.refreshFilePreview(descriptor.id).then(next => {
      if (next && descriptorRef.current?.id === next.id && next.revision !== descriptorRef.current.revision) {
        updateFilePaneSession(appSessionId, { file: next, note: next.watchError ? 'watch-error' : null })
      }
    }).catch(() => {})
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
    if (event.id !== current.id) return
    if (event.kind === 'updated') updateFilePaneSession(appSessionId, { file: event.descriptor, note: event.descriptor.watchError ? 'watch-error' : null })
    else if (event.kind === 'removed' || event.kind === 'watch-error' || event.kind === 'update-error') updateFilePaneSession(appSessionId, { note: event.kind })
    else if (event.kind === 'navigate') {
      void requestOpenFile(appSessionId, event.path).then(opened => { if (!opened) toast('Could not open this file', { tone: 'warn' }) })
    }
  }), [appSessionId, toast, onFocusComposer])

  useLayoutEffect(() => {
    if (!appMenu || !menuRef.current || !appTrigger.current) return
    const box = appTrigger.current.getBoundingClientRect()
    menuRef.current.style.setProperty('--file-menu-top', `${box.bottom + 5}px`)
    menuRef.current.style.setProperty('--file-menu-left', `${Math.max(8, Math.min(window.innerWidth - 252, box.right - 244))}px`)
    menuRef.current.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus()
  }, [appMenu])

  const failed = (next: PaintedFile) => {
    if (!mounted.current) return
    if (rejectFilePaneCandidate(appSessionId, next.descriptor)) toast('Could not open this file', { tone: 'warn' })
  }
  const ready = async (next: PaintedFile, restoredScroll?: FilePaneScroll) => {
    const current = getFilePaneSession(appSessionId)
    const restoringCommitted = !paintedRef.current && current.committedFile?.url === next.descriptor.url
    if (!mounted.current || !current.open || readyKeys.current.has(next.key) ||
      descriptorRef.current?.url !== next.descriptor.url && !restoringCommitted) return
    readyKeys.current.add(next.key)
    committingRef.current = next
    setCommitting(next)
    try {
      const previous = paintedRef.current
      const replacingSameFile = previous?.descriptor.path === next.descriptor.path
      const scroll = restoredScroll ?? (replacingSameFile ? await readScroll() : getFilePaneSession(appSessionId).scroll)
      if (!restoringCommitted && !await window.catcode.commitFilePreview(next.descriptor.id, next.descriptor.revision)) {
        failed(next)
        return
      }
      if (next.descriptor.kind === 'html' || next.descriptor.kind === 'svg') {
        await window.catcode.restoreFilePreviewScroll(next.descriptor.id, next.descriptor.revision, { x: scroll.x, y: scroll.y })
      }
      const latest = getFilePaneSession(appSessionId)
      const queuedRevision = latest.file?.id === next.descriptor.id && latest.file.path === next.descriptor.path &&
        latest.file.revision > next.descriptor.revision
      const newerCommitted = latest.committedFile?.id === next.descriptor.id && latest.committedFile.revision > next.descriptor.revision
      if (!mounted.current || !latest.open || newerCommitted || descriptorRef.current?.url !== next.descriptor.url && !queuedRevision &&
        !(restoringCommitted && latest.committedFile?.url === next.descriptor.url)) return
      if (!restoringCommitted) updateFilePaneSession(appSessionId, { committedFile: next.descriptor, checkpoint: null })
      rememberFilePaneScroll(appSessionId, scroll)
      setPainted(next)
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
  const name = descriptor.path.split('/').at(-1) ?? descriptor.path
  const displayed = descriptor.displayPath
  const split = displayed.lastIndexOf('/') + 1
  const selected = apps?.selected ?? 'default'
  const selectedLabel = apps?.applications.find(app => app.target === selected)?.label ?? 'Default application'
  const openApp = async (target: OpenWorkspaceFileTarget) => {
    setAppMenu(false)
    try {
      const opened = await window.catcode.chooseFilePreviewApplication(appSessionId, descriptor.path, target)
      if (!opened) toast('Could not open this file', { tone: 'warn' })
      else if (target !== 'finder') setApps(current => current ? { ...current, selected: target } : current)
    } catch { toast('Could not open this file', { tone: 'warn' }) }
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
      if (next) { updateFilePaneSession(appSessionId, { file: next, note: next.watchError ? 'watch-error' : null }); setReload(value => value + 1) }
    } catch { updateFilePaneSession(appSessionId, { note: 'watch-error' }) }
  }
  return <aside className="file-pane" aria-label={`File preview: ${name}`} onKeyDown={event => {
    if (event.key === 'Escape' && !event.defaultPrevented && !pathMenu && !appMenu) { event.preventDefault(); event.stopPropagation(); closeFilePane(appSessionId); onFocusComposer?.() }
  }}>
    <header className="file-pane-header">
      <button type="button" className="file-pane-icon" aria-label="Back" title="Back" disabled={!state.history.length}
        onClick={() => { void stepFilePaneHistory(appSessionId, 'back').then(ok => { if (!ok) toast('Could not open this file', { tone: 'warn' }) }) }}><PaneArrow back /></button>
      <button type="button" className="file-pane-icon" aria-label="Forward" title="Forward" disabled={!state.forward.length}
        onClick={() => { void stepFilePaneHistory(appSessionId, 'forward').then(ok => { if (!ok) toast('Could not open this file', { tone: 'warn' }) }) }}><PaneArrow /></button>
      <button type="button" className="file-pane-icon" aria-label="Reload" title="Reload" onClick={() => { void reloadFile() }}><ReloadIcon /></button>
      <div ref={headerPath} className="file-pane-path" tabIndex={0} role="button" title={descriptor.path}
        onPointerDown={event => { drag.current = { x: event.clientX, y: event.clientY, moved: false } }}
        onPointerMove={event => { if (drag.current && Math.abs(event.clientX - drag.current.x) + Math.abs(event.clientY - drag.current.y) > 3) drag.current.moved = true }}
        onClick={event => {
          if (copyTimer.current) clearTimeout(copyTimer.current)
          if (event.metaKey) { void openApp(selected); return }
          if (event.detail > 1 || drag.current?.moved || selectedPathText()) return
          copyTimer.current = setTimeout(copyPath, 220)
        }}
        onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); copyPath() } }}
        onCopy={event => { const text = window.getSelection()?.toString(); if (text) { event.preventDefault(); event.clipboardData.setData('text/plain', text.replace(/[\r\n]+$/, '')) } }}
        onContextMenu={event => { if (selectedPathText()) return; event.preventDefault(); setPathMenu({ type: 'pointer', x: event.clientX, y: event.clientY }) }}>
        <span className="file-pane-path-text"><bdi><span className="file-pane-folder">{displayed.slice(0, split)}</span>{displayed.slice(split)}</bdi></span>
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
    {state.note ? <div className="file-pane-note" role="status">{state.note === 'removed' ? `${name} was removed. Showing the last version.` : state.note === 'watch-error' ? 'File watching stopped. Showing the last version.' : 'Could not update this file. Showing the last version.'}</div> : null}
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
        <div className="file-pane-menu-seam" />
        <button type="button" className="file-pane-app-row" role="menuitem" onClick={() => { void openApp('finder') }}><ExternalAppIcon request={{ target: 'finder' }} /><span>Reveal in Finder</span></button>
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
  if (file.kind === 'html' || file.kind === 'svg') return <iframe className={className} src={file.url} title={file.path.split('/').at(-1)}
    sandbox="allow-scripts allow-same-origin" onLoad={loaded} />
  if (file.kind === 'image') return <div ref={bodyRef} className={`${className} file-pane-image`}><img src={file.url} alt={file.path.split('/').at(-1)} onLoad={loaded} onError={onFailure} draggable={false} /></div>
  const openLocal = (href: string) => {
    const path = href.startsWith('/') ? href : `${file.path.slice(0, file.path.lastIndexOf('/') + 1)}${href}`
    const opening = isPaneFilePath(path) ? requestOpenFile(appSessionId, path) : window.catcode.openWorkspaceFile(appSessionId, path)
    void opening.then(opened => { if (!opened) toast('Could not open this file', { tone: 'warn' }) })
      .catch(() => toast('Could not open this file', { tone: 'warn' }))
  }
  const Anchor = ({ href, children }: ComponentPropsWithoutRef<'a'>) => {
    if (!href) return <span>{children}</span>
    if (/^[a-z][a-z\d+.-]*:/i.test(href) || href.startsWith('//')) return <a href={href} target="_blank" rel="noreferrer">{children}</a>
    if (href.startsWith('#')) return <a href={href} onClick={event => {
      event.preventDefault(); document.getElementById(href.slice(1))?.scrollIntoView()
    }}>{children}</a>
    return <button className="file-pane-markdown-link" type="button" onClick={() => {
      let path = href
      try { path = decodeURIComponent(href) } catch { /* Keep a literal percent in the filename. */ }
      openLocal(path)
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
    onScroll={event => { if (active) rememberFilePaneScroll(appSessionId, { x: event.currentTarget.scrollLeft, y: event.currentTarget.scrollTop, markdown: captureMarkdownReadingPosition(event.currentTarget) }) }}>
    <div className="file-pane-markdown-column md-prose">
      <BoundedMarkdown sourceId={`file:${file.path}`} source={file.markdown ?? ''} scrollContainerRef={scrollElement}
        initialReadingPosition={initialScroll.current.markdown} initialScrollOffset={initialScroll.current.y} renderLeaf={leaf =>
        renderMarkdownTree(leaf.tree, { a: Anchor, img: Image })} />
    </div>
  </div>
}
function PaneArrow({ back = false }: { back?: boolean }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d={back ? 'M20 12H4m7-7-7 7 7 7' : 'M4 12h16m-7-7 7 7-7 7'} /></svg>
}
function ReloadIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6" /></svg>
}
