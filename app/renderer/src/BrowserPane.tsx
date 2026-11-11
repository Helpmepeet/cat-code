import { useLayoutEffect, useRef } from 'react'
import type { BrowserPaneCommand, BrowserPaneLayout, BrowserPaneSnapshot } from '../../shared/browserPanePresentation.js'
import './browserPane.css'
import { hideScreenPane } from './filePaneState.js'
import codingCat from './assets/browser-header-cats/coding.png'
import { SidePaneNavigation } from './SidePaneNavigation.js'
import sleepingCat from './assets/browser-header-cats/sleeping.png'
import stretchingCat from './assets/browser-header-cats/stretching.png'

export function BrowserGlobe() {
  return <svg aria-hidden viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" /></svg>
}
const paths = { back: 'M15 18l-6-6 6-6', forward: 'M9 18l6-6-6-6', reload: 'M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5', external: 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5', close: 'M6 6l12 12M18 6L6 18' }
function BrowserAddress({ state }: { state: BrowserPaneSnapshot }) {
  try {
    const url = new URL(state.url)
    if (url.protocol === 'http:') return <>{url.host}<span className="file-pane-folder">{url.pathname === '/' && !url.search && !url.hash ? '' : `${url.pathname}${url.search}${url.hash}`}</span></>
  } catch { /* Local paths use the file pane's folder and filename treatment. */ }
  const split = state.displayUrl.lastIndexOf('/') + 1
  return <><span className="file-pane-folder">{state.displayUrl.slice(0, split)}</span>{state.displayUrl.slice(split)}</>
}
function accentRGB(host: HTMLElement) {
  const probe = document.createElement('span')
  probe.className = 'browser-pane-accent-probe'
  host.append(probe)
  const color = getComputedStyle(probe).color
  probe.remove()
  const raw = getComputedStyle(host).getPropertyValue('--accent').trim()
  const hex = /^#([\da-f]{6})$/i.exec(raw)
  const channels = hex ? [0, 2, 4].map(offset => parseInt(hex[1]!.slice(offset, offset + 2), 16)) : color.match(/[\d.]+/g)?.slice(0, 3).map(Number)
  return { r: channels?.[0] ?? 0, g: channels?.[1] ?? 0, b: channels?.[2] ?? 0 }
}
const OVERLAY_SURFACES = '[role="dialog"], [role="menu"], [role="listbox"], [role="tooltip"], [class*="popover"], [class*="scrim"], [class*="modal"]'
function overlappingOverlay(host: HTMLElement, bounds: DOMRect, surfaces: readonly HTMLElement[]): boolean {
  return surfaces.some(element => {
    if (element === host || host.contains(element) || element.contains(host) || element.matches('.subagent-shared-resize, [role="separator"]') || element.closest('[hidden], [inert]')) return false
    const style = getComputedStyle(element)
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false
    if (style.position !== 'fixed' && style.position !== 'absolute') return false
    const rect = element.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0 && rect.left < bounds.right && rect.right > bounds.left && rect.top < bounds.bottom && rect.bottom > bounds.top
  })
}
export function BrowserPane({ state, active, onHide }: { state: BrowserPaneSnapshot; active: boolean; onHide?: () => void }) {
  const host = useRef<HTMLDivElement>(null)
  const command = (command: Exclude<BrowserPaneCommand['command'], 'history'>) => {
    void window.catcode.browserPaneCommand({ appSessionId: state.appSessionId, command }).then(result => {
      if (result.ok === false) console.error('Browser pane command refused', { command, appSessionId: state.appSessionId, message: result.message })
    }).catch(error => console.error('Browser pane command failed', { command, appSessionId: state.appSessionId, error }))
  }
  useLayoutEffect(() => {
    const element = host.current!
    let accent = accentRGB(element)
    let failed = false
    const send = (layout: BrowserPaneLayout) => {
      try {
        window.catcode.reportBrowserPaneLayout(layout)
        failed = false
        return true
      } catch (error) {
        if (!failed) console.error('Browser pane layout failed', { appSessionId: state.appSessionId, error })
        failed = true
        return false
      }
    }
    const hidden = () => send({ appSessionId: state.appSessionId, rect: null, overlay: false, accent })
    if (!active) { hidden(); return }
    let disposed = false
    let frame: number | null = null
    let lastFrameAt = -Infinity
    let lastSentAt = -Infinity
    let lastLayout = ''
    let surfaces: HTMLElement[] = []
    let surfacesDirty = true
    let accentDirty = false
    const report = () => {
      if (surfacesDirty) {
        // Keep the document-wide search off the geometry-only resize path.
        surfaces = [...document.body.querySelectorAll<HTMLElement>(`body > *, ${OVERLAY_SURFACES}`)]
        surfacesDirty = false
      }
      if (accentDirty) { accent = accentRGB(element); accentDirty = false }
      const visible = document.visibilityState === 'visible' && !element.closest('[hidden], [inert]')
      const rect = visible ? element.getBoundingClientRect() : null
      const layout: BrowserPaneLayout = { appSessionId: state.appSessionId,
        rect: rect && rect.width > 4 && rect.height > 4 ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null,
        overlay: !!rect && overlappingOverlay(element, rect, surfaces), accent }
      const key = JSON.stringify(layout)
      const now = performance.now()
      if (key === lastLayout && now - lastSentAt < 400) return
      if (send(layout)) { lastLayout = key; lastSentAt = now }
    }
    const schedule = () => {
      if (frame !== null || disposed) return
      frame = requestAnimationFrame(now => {
        frame = null
        // High-refresh displays must leave room in the shared IPC budget for controls.
        if (now - lastFrameAt < 16) { schedule(); return }
        lastFrameAt = now
        report()
      })
    }
    const refresh = () => {
      surfacesDirty = true
      accentDirty = true
      schedule()
    }
    report()
    const interval = window.setInterval(refresh, 400)
    const resize = new ResizeObserver(schedule); resize.observe(element)
    const mutations = new MutationObserver(records => {
      let relevant = false
      for (const record of records) {
        if (record.type === 'childList' && [...record.addedNodes, ...record.removedNodes].every(node => node instanceof HTMLElement && node.classList.contains('browser-pane-accent-probe'))) continue
        const target = record.target instanceof HTMLElement ? record.target : record.target.parentElement
        if (!target) continue
        if (record.type === 'attributes' && (target === element || target.contains(element))) {
          relevant = true
          // Width writes on the slot do not change the inherited accent.
          if (record.attributeName !== 'style' || target === element || target === document.body || target === document.documentElement) accentDirty = true
        }
        const surfaceChanged = record.type === 'attributes'
          ? !!target.closest(OVERLAY_SURFACES) || surfaces.some(surface => surface === target || !surface.contains(element) && target.contains(surface))
          : target === document.body || !!target.closest(OVERLAY_SURFACES) || [...record.addedNodes, ...record.removedNodes].some(node =>
            node instanceof HTMLElement && (node.matches(OVERLAY_SURFACES) || node.querySelector(OVERLAY_SURFACES) || surfaces.includes(node)))
        if (surfaceChanged) { surfacesDirty = true; relevant = true }
      }
      if (relevant) schedule()
    })
    mutations.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'inert', 'open', 'role'] })
    window.addEventListener('resize', refresh); window.addEventListener('scroll', schedule, true); document.addEventListener('visibilitychange', schedule)
    return () => {
      disposed = true
      if (frame !== null) cancelAnimationFrame(frame)
      window.clearInterval(interval); resize.disconnect(); mutations.disconnect()
      window.removeEventListener('resize', refresh); window.removeEventListener('scroll', schedule, true); document.removeEventListener('visibilitychange', schedule)
      hidden()
    }
  }, [active, state.appSessionId])
  const action = (name: keyof typeof paths, label: string, disabled = false) => <button type="button" className="file-pane-icon" aria-label={label} title={label} disabled={disabled} onClick={() => command(name)}><svg aria-hidden viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d={paths[name]} /></svg></button>
  return <aside className="file-pane browser-pane">
    <header className="file-pane-header"><SidePaneNavigation />{action('reload', 'Reload')}
      <div className="file-pane-path" title={state.displayUrl}><span className="file-pane-path-text"><bdi><BrowserAddress state={state} /></bdi></span></div>
      {state.controller === 'agent' ? <span className="browser-header-cat" aria-hidden="true"><img src={codingCat} alt="" /></span> :
        <button type="button" className="browser-header-cat browser-header-cat-user" aria-label="Give back" title="Give back" onClick={() => command('handback')}><img className="browser-cat-sleeping" src={sleepingCat} alt="" /><img className="browser-cat-stretching" src={stretchingCat} alt="" /></button>}
      {action('external', 'Open in default browser')}
      <button type="button" className="file-pane-icon" aria-label="Hide browser" title="Hide browser" onClick={onHide ?? (() => hideScreenPane(state.appSessionId, 'browser'))}><svg aria-hidden viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d={paths.close} /></svg></button>
    </header>
    <div ref={host} className="file-pane-host browser-pane-host" data-agent={state.controller === 'agent' || undefined}>
      {state.still !== null ? <img className="browser-pane-still" src={state.still} alt="" onClick={() => command('takeover')} /> : null}
    </div>
  </aside>
}
