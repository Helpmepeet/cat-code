import { pathToFileURL } from 'node:url'
import type { BrowserPaneHost, BrowserPaneRecord, BrowserPaneView } from './browserPaneHost.js'
import type { BrowserPaneSnapshot, BrowserPaneEvent, BrowserPaneLayout, BrowserPaneCommand, BrowserPaneCommandResult } from '../shared/browserPanePresentation.js'

export interface BrowserPanePresentationNative {
  attach(window: unknown, view: BrowserPaneView): void
  detach(window: unknown, view: BrowserPaneView): void
  bounds(view: BrowserPaneView, rect: { x: number; y: number; width: number; height: number }): void
  visible(view: BrowserPaneView, visible: boolean): void
  capture(view: BrowserPaneView): Promise<string>
}
export type BrowserPanePresentationDependencies = {
  host: BrowserPaneHost
  sessions: () => readonly { appSessionId: string }[]
  window: () => unknown | null
  native: BrowserPanePresentationNative
  publish: (event: BrowserPaneEvent) => void
  openExternal: (url: string) => Promise<unknown>
  now?: () => number
  schedule?: (callback: () => void, milliseconds: number) => (() => void)
  onError?: (error: unknown) => void
}
function closed(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key))
}
function validLayout(value: unknown): value is BrowserPaneLayout {
  if (!closed(value, ['appSessionId', 'rect', 'overlay', 'accent']) || typeof value.appSessionId !== 'string' || typeof value.overlay !== 'boolean') return false
  const accent = value.accent
  if (!closed(accent, ['r', 'g', 'b']) || !['r', 'g', 'b'].every(k => Number.isInteger(accent[k]) && (accent[k] as number) >= 0 && (accent[k] as number) <= 255)) return false
  const rect = value.rect
  return rect === null || closed(rect, ['x', 'y', 'width', 'height']) && ['x', 'y', 'width', 'height'].every(k => typeof rect[k] === 'number' && Number.isFinite(rect[k]) && (rect[k] as number) >= 0 && (rect[k] as number) <= 32768)
}
/** Main-only state. The renderer receives cloned snapshots, never the native records. */
export class BrowserPanePresentation {
  private readonly records = new Map<string, BrowserPaneRecord>()
  private readonly states = new Map<string, BrowserPaneSnapshot>()
  private readonly versions = new Map<string, number>()
  private readonly attached = new Map<BrowserPaneView, unknown>()
  private selected: BrowserPaneLayout | null = null
  private reportedAt = 0
  private epoch = 0
  private pendingCapture: { record: BrowserPaneRecord; epoch: number; promise: Promise<void> } | undefined
  private cancelTimer: (() => void) | undefined
  private disposed = false
  constructor(private readonly deps: BrowserPanePresentationDependencies) {}
  private report(error: unknown): void {
    if (this.deps.onError) this.deps.onError(error)
    else console.error('[browser-pane-presentation]', error)
  }
  private known(id: string): boolean { return /^[A-Za-z0-9_-]{1,128}$/.test(id) && this.deps.sessions().some(session => session.appSessionId === id) }
  private now(): number { return this.deps.now?.() ?? Date.now() }
  private emit(id: string): void {
    const state = this.states.get(id)
    this.deps.publish({ appSessionId: id, state: state ? { ...state } : null })
  }
  snapshots(): BrowserPaneSnapshot[] { return [...this.states.values()].filter(state => this.known(state.appSessionId)).map(state => ({ ...state })) }
  async onHostChange(record: BrowserPaneRecord | undefined, id: string): Promise<void> {
    if (this.disposed) return
    const version = (this.versions.get(id) ?? 0) + 1
    this.versions.set(id, version)
    const previous = this.records.get(id)
    if (previous && previous !== record) this.release(previous)
    if (!record || !this.known(id)) {
      if (previous === record && previous) this.release(previous)
      this.records.delete(id); this.states.delete(id)
      this.emit(id)
      return
    }
    this.records.set(id, record)
    try {
      const url = record.view.getURL?.() || record.url
      const local = await this.deps.host.policy.localPath(id, url)
      if (this.disposed || this.versions.get(id) !== version || this.records.get(id) !== record) return
      const history = record.view.history?.() ?? { canGoBack: false, canGoForward: false }
      this.states.set(id, { appSessionId: id, url, displayUrl: local ?? url, controller: record.controller, ...history, still: this.states.get(id)?.still ?? null, agentUseSequence: record.agentUseSequence })
      this.emit(id)
      await this.reconcile()
    } catch (error) { this.hide(record); this.report(error) }
  }
  private hide(record: BrowserPaneRecord): void {
    record.visible = false
    try { this.deps.native.visible(record.view, false) } catch (error) { this.report(error) }
  }
  private release(record: BrowserPaneRecord): void {
    this.hide(record)
    const window = this.attached.get(record.view)
    if (window !== undefined) {
      try { this.deps.native.detach(window, record.view) } catch (error) { this.report(error) }
      this.attached.delete(record.view)
    }
  }
  private clearStill(id: string): void {
    const state = this.states.get(id)
    if (state?.still) { state.still = null; this.emit(id) }
  }
  rendererLost(): void {
    this.epoch++
    this.selected = null
    this.pendingCapture = undefined
    this.cancelTimer?.(); this.cancelTimer = undefined
    for (const [id, record] of this.records) { this.hide(record); this.clearStill(id) }
  }
  dispose(): void {
    this.rendererLost()
    this.disposed = true
    for (const record of this.records.values()) this.release(record)
    this.records.clear(); this.states.clear()
  }
  private armTimer(): void {
    this.cancelTimer?.()
    const callback = () => {
      if (!this.selected) return
      if (this.now() - this.reportedAt >= 1500) this.rendererLost()
      else this.armTimer()
    }
    const ms = Math.max(1, 1500 - (this.now() - this.reportedAt))
    if (this.deps.schedule) this.cancelTimer = this.deps.schedule(callback, ms)
    else { const timer = setTimeout(callback, ms); timer.unref?.(); this.cancelTimer = () => clearTimeout(timer) }
  }
  async layout(input: BrowserPaneLayout): Promise<void> {
    if (this.disposed) return
    if (!validLayout(input) || !this.known(input.appSessionId)) { this.rendererLost(); return }
    const changed = JSON.stringify(this.selected) !== JSON.stringify(input)
    if (changed) { this.epoch++; this.pendingCapture = undefined }
    this.selected = { ...input, rect: input.rect ? { ...input.rect } : null, accent: { ...input.accent } }
    this.reportedAt = this.now()
    this.armTimer()
    try { await this.reconcile() } catch (error) { this.rendererLost(); this.report(error) }
  }
  private async reconcile(): Promise<void> {
    const input = this.selected
    const window = this.deps.window()
    const record = input ? this.records.get(input.appSessionId) : undefined
    for (const [id, candidate] of this.records) {
      if (candidate !== record || !input?.rect || !window || !this.known(id)) { this.hide(candidate); this.clearStill(id) }
    }
    if (!input?.rect || !record || !window || !this.known(input.appSessionId) || this.now() - this.reportedAt >= 1500) {
      if (record) this.hide(record)
      return
    }
    const { rect } = input
    const x = Math.ceil(rect.x + 2), y = Math.ceil(rect.y + 2)
    const width = Math.floor(rect.x + rect.width - 2) - x, height = Math.floor(rect.y + rect.height - 2) - y
    if (width <= 0 || height <= 0) { this.hide(record); this.clearStill(record.id); return }
    const previousWindow = this.attached.get(record.view)
    if (previousWindow !== window) {
      this.hide(record)
      if (previousWindow !== undefined) this.deps.native.detach(previousWindow, record.view)
      this.deps.native.attach(window, record.view)
      this.attached.set(record.view, window)
    }
    this.deps.native.bounds(record.view, { x, y, width, height })
    record.cdp?.setAccent(input.accent)
    // A selected browser remains LRU-protected while an overlay shows its still.
    record.visible = true
    if (!input.overlay) {
      this.clearStill(record.id)
      this.deps.native.visible(record.view, true)
      return
    }
    if (this.states.get(record.id)?.still) { this.deps.native.visible(record.view, false); return }
    if (this.pendingCapture?.record === record && this.pendingCapture.epoch === this.epoch) return this.pendingCapture.promise
    const epoch = this.epoch
    const promise = (async () => {
      try {
        const still = await this.deps.native.capture(record.view)
        if (this.epoch === epoch && (this.now() - this.reportedAt >= 1500 || this.deps.window() !== window)) { this.rendererLost(); return }
        if (this.epoch !== epoch || this.records.get(record.id) !== record || this.selected?.appSessionId !== record.id || !this.selected.overlay || this.now() - this.reportedAt >= 1500 || this.deps.window() !== window) return
        if (!still.startsWith('data:image/png;base64,') || still.length > 4_000_000) throw new Error('Invalid browser still capture')
        const state = this.states.get(record.id)
        if (state) { state.still = still; this.emit(record.id) }
      } catch (error) { this.report(error) }
      finally {
        // Never let an old capture hide a newer session or a newly shown live view.
        if (this.epoch === epoch && this.records.get(record.id) === record && this.selected?.overlay) this.deps.native.visible(record.view, false)
      }
    })()
    this.pendingCapture = { record, epoch, promise }
    await promise
    if (this.pendingCapture?.promise === promise) this.pendingCapture = undefined
  }
  async command(input: BrowserPaneCommand): Promise<BrowserPaneCommandResult> {
    const fail = (message: string): BrowserPaneCommandResult => ({ ok: false, message })
    if (this.disposed || !closed(input, ['appSessionId', 'command']) || typeof input.appSessionId !== 'string' || !this.known(input.appSessionId) || !['back', 'forward', 'reload', 'external', 'close', 'takeover'].includes(input.command)) return fail('Invalid browser command')
    const id = input.appSessionId
    const record = this.deps.host.get(id)
    if (!record) return fail('No browser page is open')
    try {
      switch (input.command) {
        case 'takeover':
          // Do not show the native view over an overlay. A fresh live layout may show it.
          this.deps.host.takeOver(id)
          break
        case 'close':
          this.release(record)
          await this.deps.host.close(id)
          await this.onHostChange(undefined, id)
          return { ok: true }
        case 'external': {
          const url = record.view.getURL?.() || record.url
          const local = await this.deps.host.policy.localPath(id, url)
          if (!this.known(id) || this.deps.host.get(id) !== record) return fail('The browser page is closed')
          if (!local && !this.deps.host.policy.loopback(url)) return fail('This browser URL cannot be opened externally')
          await this.deps.openExternal(local ? pathToFileURL(local).href : url)
          break
        }
        default: {
          const result = await this.deps.host.headerNavigate(id, { action: input.command })
          if (result.ok === false) return fail(result.error.message)
        }
      }
      await this.onHostChange(this.deps.host.get(id), id)
      return { ok: true }
    } catch (error) { this.report(error); return fail(error instanceof Error ? error.message : String(error)) }
  }
}
