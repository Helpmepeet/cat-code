import { stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { BrowserPanePolicy, type BrowserPanePolicyDependencies } from './browserPanePolicy.js'
import { parseBrowserArgs, type BrowserRequestArgs, type BrowserResult } from '../shared/browserPane.js'
import { BrowserPaneCdp, isUserBrowserInput, type BrowserCapturedPage, type BrowserCdpCommand } from './browserPaneCdp.js'

export type BrowserNavigationOptions = { ignoreBeforeUnload?: boolean }
export interface BrowserPaneViewHooks {
  input(input: { type: string; _modifiers?: number }): void
  navigated(): void
  titleUpdated?(): void
  nativeDialog(open: boolean): void
  beforeUnload(): void
  cdpEvent(method: string, params: unknown, sessionId?: string): void
}
export interface BrowserPaneView {
  navigate(url: string, options?: BrowserNavigationOptions): Promise<void>
  back(options?: BrowserNavigationOptions): Promise<void>
  forward(options?: BrowserNavigationOptions): Promise<void>
  reload(options?: BrowserNavigationOptions): Promise<void>
  getURL?(): string
  getTitle?(): string
  history?(): { canGoBack: boolean; canGoForward: boolean }
  historyEntry?(): Promise<string>
  restoreHistoryEntry?(entry: string, options?: BrowserNavigationOptions): Promise<void>
  setHooks?(hooks: BrowserPaneViewHooks): void
  capturePage?(maxPixels: number): Promise<BrowserCapturedPage>
  destroy(): void
  clearData(): Promise<void>
  /** The real adapter exposes WebContentsView and its attached debugger here. */
  nativeView?: unknown
  debugger?: { sendCommand: BrowserCdpCommand }
}
export interface BrowserPaneAdapter {
  startup(): Promise<void>
  create(id: string, policy: BrowserPanePolicy): Promise<BrowserPaneView>
}
export type BrowserPaneRecord = { id: string; view: BrowserPaneView; url: string; visible: boolean; controller: 'agent' | 'user'; lastUsed: number; agentUseSequence: number; cdp?: BrowserPaneCdp; automationReady?: boolean; nativeDialog: boolean }
class BrowserUnavailable extends Error {}
export class BrowserPaneHost {
  readonly records = new Map<string, BrowserPaneRecord>()
  readonly policy: BrowserPanePolicy
  private queue: Promise<unknown> = Promise.resolve()
  private started: Promise<void> | undefined
  private disposed = false
  private clock = 0
  private pageGeneration = 0
  private nextAgentUseSequence = 0
  private active = new Map<string, (message: string) => void>()
  constructor(private readonly deps: BrowserPanePolicyDependencies & {
    adapter: BrowserPaneAdapter
    now?: () => number
    onChange?: (record: BrowserPaneRecord | undefined, id: string) => void
    onDialog?: (id: string, report: { type: string; message: string; accepted: boolean }) => void
  }) { this.policy = new BrowserPanePolicy(deps) }
  get(id: string): BrowserPaneRecord | undefined { return this.records.get(id) }
  private publish(id: string): void { this.deps.onChange?.(this.records.get(id), id) }
  takeOver(id: string): void {
    const record = this.records.get(id)
    if (!record) return
    record.controller = 'user'
    void record.cdp?.clearMark(() => {}).catch(error => console.error('[browser-pane] action mark could not be cleared', error))
    this.active.get(id)?.('The user is using the browser')
    this.publish(id)
  }
  handBack(id: string): void {
    const record = this.records.get(id)
    if (!record) return
    record.controller = 'agent'
    this.publish(id)
  }
  navigate(id: string, args: BrowserRequestArgs['browser.navigate']): Promise<BrowserResult> {
    return this.handleRequest(id, { verb: 'browser.navigate', args })
  }
  headerNavigate(id: string, args: BrowserRequestArgs['browser.navigate']): Promise<BrowserResult> {
    return this.request(id, { verb: 'browser.navigate', args }, true)
  }
  restoreHistoryEntry(id: string, entry: string): Promise<void> {
    return this.serial(async () => {
      const record = this.records.get(id)
      if (this.disposed || !record?.view.restoreHistoryEntry) throw new Error('Browser history is unavailable')
      if (record.nativeDialog) throw new Error('Dismiss the browser dialog first')
      this.active.get(id)?.('The user is using the browser')
      await record.view.restoreHistoryEntry(entry, { ignoreBeforeUnload: true })
      record.url = record.view.getURL?.() || record.url
      this.publish(id)
    })
  }
  private serial<T>(run: () => Promise<T>): Promise<T> {
    const result = this.queue.then(run)
    this.queue = result.catch(() => {})
    return result
  }
  private async remove(id: string): Promise<void> {
    const record = this.records.get(id)
    if (!record) return
    record.view.destroy()
    // Retain the record on clear failure so no same-partition reopen can bypass cleanup.
    await record.view.clearData()
    this.records.delete(id)
    this.policy.forget(id)
    this.publish(id)
  }
  close(id: string): Promise<void> {
    this.active.get(id)?.('The browser is closed')
    return this.serial(() => this.remove(id))
  }
  dispose(): Promise<void> {
    this.disposed = true
    for (const abort of this.active.values()) abort('The browser is closed')
    return this.serial(async () => { for (const id of this.records.keys()) await this.remove(id) })
  }
  private async navigationTarget(id: string, target: string): Promise<string> {
    if (target.length > 8192) throw new Error('Browser target is too long')
    const current = this.records.get(id)?.view.getURL?.() || this.records.get(id)?.url
    // Existing absolute file paths retain their file meaning, even outside allowed folders.
    if (current && this.policy.loopback(current) && !/^[A-Za-z][A-Za-z\d+.-]*:/.test(target)) {
      let file = false
      if (isAbsolute(target)) {
        try { await stat(target); file = true } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') file = true }
      }
      if (!file) return this.policy.navigate(id, new URL(target, current).href)
    }
    return this.policy.navigate(id, target)
  }
  handleRequest(id: string, request: { verb: keyof BrowserRequestArgs; args: BrowserRequestArgs[keyof BrowserRequestArgs] }): Promise<BrowserResult> {
    return this.request(id, request, false)
  }
  private request(id: string, request: { verb: keyof BrowserRequestArgs; args: BrowserRequestArgs[keyof BrowserRequestArgs] }, header: boolean): Promise<BrowserResult> {
    const now = () => this.deps.now?.() ?? Date.now()
    const deadline = now() + 30_000
    return this.serial(async () => {
      const fail = (code: 'unavailable' | 'bad_request' | 'internal_error', message: string): BrowserResult => ({ ok: false, error: { code, message } })
      let finished = false
      const gate = () => {
        if (finished || now() >= deadline) throw new BrowserUnavailable('Browser operation timed out')
        if (this.disposed) throw new BrowserUnavailable('The browser is closed')
        const record = this.records.get(id)
        if (record?.nativeDialog) throw new BrowserUnavailable('A dialog is waiting for you')
        if (!header && record?.controller === 'user') throw new BrowserUnavailable('The user is using the browser')
      }
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        gate()
        if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) return fail('bad_request', 'Invalid session id')
        let args: BrowserRequestArgs[keyof BrowserRequestArgs]
        try { args = parseBrowserArgs(request.verb, request.args) } catch (error) { return fail('bad_request', String(error)) }
        const interrupted = new Promise<never>((_resolve, reject) => {
          const abort = (message: string) => {
            if (header && message === 'The user is using the browser') return
            finished = true
            reject(new BrowserUnavailable(message))
          }
          this.active.set(id, abort)
          timer = setTimeout(() => abort('Browser operation timed out'), Math.max(0, deadline - now()))
        })
        const work = async (): Promise<BrowserResult> => {
          const input = args as BrowserRequestArgs['browser.navigate']
          let target: string | undefined
          if (request.verb === 'browser.navigate' && input.action === 'navigate') {
            try { target = await this.navigationTarget(id, input.target!) } catch (error) { return fail('bad_request', String(error)) }
          }
          if (request.verb === 'browser.describe' && (args as BrowserRequestArgs['browser.describe']).operation === 'navigate') {
            const navigation = (args as BrowserRequestArgs['browser.describe']).navigate!
            const url = navigation.action === 'navigate' ? await this.navigationTarget(id, navigation.target!) : this.records.get(id)?.url ?? ''
            gate()
            const displayUrl = await this.policy.displayUrl(id, url)
            gate()
            return { ok: true, value: { description: (navigation.action === 'navigate' ? `navigate to ${displayUrl}` : `${navigation.action} on ${displayUrl}`).slice(0, 8192), url } }
          }
          gate()
          await (this.started ??= this.deps.adapter.startup())
          gate()
          let record = this.records.get(id)
          if (!record) {
            if (request.verb !== 'browser.navigate' || input.action !== 'navigate') return fail('unavailable', 'No browser page is open')
            if (this.records.size >= 4) {
              const candidate = [...this.records.values()].filter(r => !r.visible && r.controller !== 'user').sort((a, b) => a.lastUsed - b.lastUsed)[0]
              if (!candidate) return fail('unavailable', 'The browser is busy')
              gate(); await this.remove(candidate.id); gate()
            }
            const view = await this.deps.adapter.create(id, this.policy)
            try { gate() } catch (error) { view.destroy(); await view.clearData(); throw error }
            record = { id, view, url: '', visible: false, controller: 'agent', lastUsed: ++this.clock, agentUseSequence: 0, nativeDialog: false }
            this.records.set(id, record)
            const owned = record
            const nativeDialog = (open: boolean) => {
              if (this.records.get(id) !== owned) return
              owned.nativeDialog = open
              if (open) this.active.get(id)?.('A dialog is waiting for you')
              this.publish(id)
            }
            if (view.debugger && view.capturePage) {
              record.cdp = new BrowserPaneCdp({ command: (method, params, sessionId) => view.debugger!.sendCommand(method, params, sessionId),
                capture: maxPixels => view.capturePage!(maxPixels), url: () => view.getURL?.() || owned.url,
                displayUrl: () => this.policy.displayUrl(id, view.getURL?.() || owned.url),
                nextGeneration: () => ++this.pageGeneration,
                onNativeDialog: nativeDialog, onDialog: report => { if (this.records.get(id) === owned) this.deps.onDialog?.(id, report) } })
            }
            view.setHooks?.({
              input: event => { if (this.records.get(id) === owned && isUserBrowserInput(event)) this.takeOver(id) },
              navigated: () => { if (this.records.get(id) !== owned) return; owned.cdp?.navigated(); owned.url = view.getURL?.() || owned.url; this.publish(id) },
              titleUpdated: () => { if (this.records.get(id) === owned) this.publish(id) },
              nativeDialog,
              beforeUnload: () => { if (this.records.get(id) === owned) this.active.get(id)?.('The page prevented navigation') },
              cdpEvent: (method, params, sessionId) => {
                if (this.records.get(id) !== owned) return
                const lifecycleGate = () => { if (this.disposed || this.records.get(id) !== owned) throw new BrowserUnavailable('The browser is closed') }
                void owned.cdp?.event(method, params, lifecycleGate, sessionId).catch(error => {
                  if (this.records.get(id) === owned) this.active.get(id)?.(String(error))
                })
              },
            })
            if (record.cdp) {
              record.automationReady = false
              await record.cdp.initialize(gate)
              gate()
              record.automationReady = true
            }
          }
          gate()
          if (record.cdp && !record.automationReady) return fail('unavailable', 'Browser automation could not start; close the browser and reopen it')
          record.lastUsed = ++this.clock
          if (!header && request.verb !== 'browser.describe') {
            record.agentUseSequence = ++this.nextAgentUseSequence
            this.publish(id)
          }
          let value: any
          if (request.verb === 'browser.navigate') {
            const options = { ignoreBeforeUnload: header }
            await record.cdp?.clearMark(gate)
            record.cdp?.navigated()
            gate()
            switch (input.action) {
              case 'navigate': await record.view.navigate(target!, options); gate(); record.url = target!; break
              case 'back': await record.view.back(options); break
              case 'forward': await record.view.forward(options); break
              case 'reload': await record.view.reload(options); break
            }
            gate()
            record.url = record.view.getURL?.() || record.url
            value = { url: record.url }
          } else {
            if (!record.cdp) return fail('unavailable', 'Browser automation is unavailable')
            switch (request.verb) {
              case 'browser.read': value = await record.cdp.read(gate); break
              case 'browser.screenshot': value = await record.cdp.screenshot(gate); break
              case 'browser.act': value = await record.cdp.act(args as BrowserRequestArgs['browser.act'], gate); break
              case 'browser.describe': value = await record.cdp.describe(args as BrowserRequestArgs['browser.describe'], gate); break
            }
          }
          gate()
          this.publish(id)
          return { ok: true, value }
        }
        return await Promise.race([work(), interrupted])
      } catch (error) {
        return fail(error instanceof BrowserUnavailable ? 'unavailable' : 'bad_request', error instanceof Error ? error.message : String(error))
      } finally {
        finished = true
        if (timer) clearTimeout(timer)
        this.active.delete(id)
      }
    })
  }
}
