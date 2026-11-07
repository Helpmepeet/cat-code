import { useLayoutEffect, useRef } from 'react'
import type { BrowserPaneCommand, BrowserPaneSnapshot } from '../../shared/browserPanePresentation.js'
import './browserPane.css'

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
function overlappingOverlay(host: HTMLElement): boolean {
  const bounds = host.getBoundingClientRect()
  // Portal roots and semantic surfaces cover the app's menus, tooltips and modal scrims.
  const surfaces = 'body > *, [role="dialog"], [role="menu"], [role="listbox"], [role="tooltip"], [class*="popover"], [class*="scrim"], [class*="modal"]'
  return [...document.body.querySelectorAll<HTMLElement>(surfaces)].some(element => {
    if (element === host || host.contains(element) || element.contains(host) || element.matches('.subagent-shared-resize, [role="separator"]') || element.closest('[hidden], [inert]')) return false
    const style = getComputedStyle(element)
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false
    if (style.position !== 'fixed' && style.position !== 'absolute') return false
    const rect = element.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0 && rect.left < bounds.right && rect.right > bounds.left && rect.top < bounds.bottom && rect.bottom > bounds.top
  })
}
export function BrowserPane({ state, active }: { state: BrowserPaneSnapshot; active: boolean }) {
  const host = useRef<HTMLDivElement>(null)
  const command = (command: BrowserPaneCommand['command']) => {
    void window.catcode.browserPaneCommand({ appSessionId: state.appSessionId, command }).then(result => {
      if (result.ok === false) console.error('Browser pane command refused', { command, appSessionId: state.appSessionId, message: result.message })
    }).catch(error => console.error('Browser pane command failed', { command, appSessionId: state.appSessionId, error }))
  }
  useLayoutEffect(() => {
    const element = host.current!
    const hidden = () => window.catcode.reportBrowserPaneLayout({ appSessionId: state.appSessionId, rect: null, overlay: false, accent: accentRGB(element) })
    if (!active) { hidden(); return }
    let disposed = false
    const report = () => {
      if (document.visibilityState !== 'visible' || element.closest('[hidden], [inert]')) { hidden(); return }
      const rect = element.getBoundingClientRect()
      window.catcode.reportBrowserPaneLayout({ appSessionId: state.appSessionId,
        rect: rect.width > 4 && rect.height > 4 ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null,
        overlay: overlappingOverlay(element), accent: accentRGB(element) })
    }
    report()
    const interval = window.setInterval(report, 400)
    const resize = new ResizeObserver(report); resize.observe(element)
    // Coalesce mutations; computing the accent uses a transient probe of its own.
    let queued = false
    const mutations = new MutationObserver(records => {
      if (records.every(record => [...record.addedNodes, ...record.removedNodes].every(node => node instanceof HTMLElement && node.classList.contains('browser-pane-accent-probe')) && record.type === 'childList')) return
      if (!queued) { queued = true; queueMicrotask(() => { queued = false; if (!disposed && element.isConnected) report() }) }
    })
    mutations.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'inert', 'open'] })
    window.addEventListener('resize', report); window.addEventListener('scroll', report, true); document.addEventListener('visibilitychange', report)
    return () => { disposed = true; window.clearInterval(interval); resize.disconnect(); mutations.disconnect(); window.removeEventListener('resize', report); window.removeEventListener('scroll', report, true); document.removeEventListener('visibilitychange', report); hidden() }
  }, [active, state.appSessionId])
  const action = (name: keyof typeof paths, label: string, disabled = false) => <button type="button" className="file-pane-icon" aria-label={label} title={label} disabled={disabled} onClick={() => command(name)}><svg aria-hidden viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d={paths[name]} /></svg></button>
  return <aside className="file-pane browser-pane">
    <header className="file-pane-header">{action('back', 'Back', !state.canGoBack)}{action('forward', 'Forward', !state.canGoForward)}{action('reload', 'Reload')}
      <div className="file-pane-path" title={state.displayUrl}><span className="file-pane-path-text"><bdi><BrowserAddress state={state} /></bdi></span></div>
      {action('external', 'Open in default browser')}{action('close', 'Close browser')}
    </header>
    {state.controller === 'user' ? <div className="file-pane-note"><span>You have the browser. Your next message hands it back.</span></div> : null}
    <div ref={host} className="file-pane-host browser-pane-host" data-agent={state.controller === 'agent' || undefined}>
      {state.still !== null ? <img className="browser-pane-still" src={state.still} alt="" onClick={() => command('takeover')} /> : null}
    </div>
  </aside>
}
