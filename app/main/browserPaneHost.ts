import { BrowserPanePolicy, type BrowserPanePolicyDependencies } from './browserPanePolicy.js'
import { parseBrowserArgs, type BrowserRequestArgs, type BrowserResult } from '../shared/browserPane.js'

export interface BrowserPaneView {
  navigate(url: string): Promise<void>
  back(): Promise<void>
  forward(): Promise<void>
  reload(): Promise<void>
  getURL?(): string
  destroy(): void
  clearData(): Promise<void>
  /** The real adapter exposes WebContentsView and its attached debugger here. */
  nativeView?: unknown
  debugger?: { sendCommand(method: string, params?: unknown, sessionId?: string): Promise<unknown> }
}
export interface BrowserPaneAdapter {
  startup(): Promise<void>
  create(id: string, policy: BrowserPanePolicy): Promise<BrowserPaneView>
}
export type BrowserPaneRecord = { id: string; view: BrowserPaneView; url: string; visible: boolean; controller: 'agent' | 'user'; lastUsed: number }
export class BrowserPaneHost {
  readonly records = new Map<string, BrowserPaneRecord>()
  readonly policy: BrowserPanePolicy
  private queue: Promise<unknown> = Promise.resolve()
  private started: Promise<void> | undefined
  private disposed = false
  private clock = 0
  constructor(private readonly deps: BrowserPanePolicyDependencies & { adapter: BrowserPaneAdapter }) { this.policy = new BrowserPanePolicy(deps) }
  get(id: string): BrowserPaneRecord | undefined { return this.records.get(id) }
  navigate(id: string, args: BrowserRequestArgs['browser.navigate']): Promise<BrowserResult> {
    return this.handleRequest(id, { verb: 'browser.navigate', args })
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
  }
  close(id: string): Promise<void> { return this.serial(() => this.remove(id)) }
  dispose(): Promise<void> {
    this.disposed = true
    return this.serial(async () => { for (const id of this.records.keys()) await this.remove(id) })
  }
  handleRequest(id: string, request: { verb: keyof BrowserRequestArgs; args: BrowserRequestArgs[keyof BrowserRequestArgs] }): Promise<BrowserResult> {
    return this.serial(async () => {
      const fail = (code: 'unavailable' | 'bad_request' | 'internal_error', message: string): BrowserResult => ({ ok: false, error: { code, message } })
      if (this.disposed) return fail('unavailable', 'The browser is closed')
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) return fail('bad_request', 'Invalid session id')
      let args: BrowserRequestArgs[keyof BrowserRequestArgs]
      try { args = parseBrowserArgs(request.verb, request.args) } catch (error) { return fail('bad_request', String(error)) }
      if (this.records.get(id)?.controller === 'user') return fail('unavailable', 'The user is using the browser')
      if (request.verb !== 'browser.navigate') return fail('unavailable', 'This browser operation is not available yet')
      const input = args as BrowserRequestArgs['browser.navigate']
      let target: string | undefined
      try { if (input.action === 'navigate') target = await this.policy.navigate(id, input.target!) }
      catch (error) { return fail('bad_request', String(error)) }
      try {
        await (this.started ??= this.deps.adapter.startup())
        let record = this.records.get(id)
        if (!record) {
          if (input.action !== 'navigate') return fail('unavailable', 'No browser page is open')
          if (this.records.size >= 4) {
            const candidate = [...this.records.values()].filter(r => !r.visible && r.controller !== 'user').sort((a, b) => a.lastUsed - b.lastUsed)[0]
            if (!candidate) return fail('unavailable', 'The browser is busy')
            await this.remove(candidate.id)
          }
          const view = await this.deps.adapter.create(id, this.policy)
          record = { id, view, url: '', visible: false, controller: 'agent', lastUsed: ++this.clock }
          this.records.set(id, record)
        }
        record.lastUsed = ++this.clock
        switch (input.action) {
          case 'navigate': await record.view.navigate(target!); record.url = target!; break
          case 'back': await record.view.back(); break
          case 'forward': await record.view.forward(); break
          case 'reload': await record.view.reload(); break
        }
        record.url = record.view.getURL?.() ?? record.url
        return { ok: true, value: { url: record.url } }
      } catch (error) { return fail('internal_error', String(error)) }
    })
  }
}
