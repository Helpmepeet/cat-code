export type BrowserPaneSnapshot = {
  appSessionId: string
  url: string
  displayUrl: string
  controller: 'agent' | 'user'
  canGoBack: boolean
  canGoForward: boolean
  still: string | null
  /** Advances on agent tool dispatch, not on navigation notifications, control or still updates. */
  agentUseSequence?: number
}
export type BrowserPaneEvent = { appSessionId: string; state: BrowserPaneSnapshot | null }
export type BrowserPaneCommand = {
  appSessionId: string
  command: 'back' | 'forward' | 'reload' | 'external' | 'close' | 'takeover' | 'handback'
}
export type BrowserPaneLayout = {
  appSessionId: string
  /** Host bounds in renderer CSS pixels; main applies the native view's 2px inset. */
  rect: { x: number; y: number; width: number; height: number } | null
  overlay: boolean
  accent: { r: number; g: number; b: number }
}
export type BrowserPaneCommandResult = { ok: true } | { ok: false; message: string }
