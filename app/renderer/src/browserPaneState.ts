import { useFilePaneSession, updateFilePaneSession, getFilePaneSession } from './filePaneState.js'
import type { BrowserPaneEvent, BrowserPaneSnapshot } from '../../shared/browserPanePresentation.js'
export function getBrowserPaneSnapshot(id: string): BrowserPaneSnapshot | null { return getFilePaneSession(id).browser }
export function applyBrowserPaneEvent({ appSessionId, state }: BrowserPaneEvent): void {
  updateFilePaneSession(appSessionId, { browser: state })
}
export function useBrowserPaneSnapshot(id: string): BrowserPaneSnapshot | null { return useFilePaneSession(id).browser }
export function browserPaneLabel(state: BrowserPaneSnapshot): string {
  try { const url = new URL(state.url); return url.protocol === 'http:' || url.protocol === 'https:' ? url.host : decodeURIComponent(state.displayUrl.split('/').at(-1) || state.displayUrl) } catch { return state.displayUrl.split('/').at(-1) || state.displayUrl }
}
export function installBrowserPaneSubscription(): () => void {
  let live = true
  const updated = new Set<string>()
  const stop = window.catcode.onBrowserPane(event => { updated.add(event.appSessionId); applyBrowserPaneEvent(event) })
  void window.catcode.browserPaneSnapshot().then(states => {
    if (live) for (const state of states) if (!updated.has(state.appSessionId)) applyBrowserPaneEvent({ appSessionId: state.appSessionId, state })
  }).catch(error => console.error('[browser-pane] snapshot failed', error))
  return () => { live = false; stop() }
}
