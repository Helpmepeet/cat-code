import type { BrowserActInput, BrowserDescribeInput, BrowserRequestValues } from '../shared/browserPane.js'
import { BROWSER_ARM_CONFIRM_SCRIPT, BROWSER_DIALOG_BINDING, BROWSER_DIALOG_SCRIPT } from './browserPaneDialogs.js'

export type BrowserDispatchGate = () => void
export type BrowserCdpCommand = (method: string, params?: any, sessionId?: string) => Promise<any>
export type BrowserCapturedPage = { data: string; width: number; height: number }
export const BROWSER_SCREENSHOT_MAX_PIXELS = 2_000_000
const MAX_TEXT = 32_000
const MAX_NODES = 300
export function isUserBrowserInput(input: { type: string; _modifiers?: number }): boolean {
  return ['mouseDown', 'rawKeyDown', 'keyDown', 'touchStart'].includes(input.type) && !((input._modifiers ?? 0) & (1 << 23))
}
const TARGET_DETAILS = `function() {
  let e = this;
  if (!e || !e.ownerDocument) throw new Error('No target element');
  let w = e.ownerDocument.defaultView, crossOrigin = false;
  try { crossOrigin = w.location.origin !== w.top.location.origin; } catch { crossOrigin = true; }
  if (e.tagName === 'IFRAME' || e.tagName === 'FRAME') {
    try { if (!e.contentDocument || e.contentWindow.location.origin !== w.top.location.origin) crossOrigin = true; } catch { crossOrigin = true; }
  }
  const r = e.getBoundingClientRect(); let x = r.left + r.width / 2, y = r.top + r.height / 2;
  try { while (w !== w.top) { const f = w.frameElement, b = f.getBoundingClientRect(); x += b.left + f.clientLeft; y += b.top + f.clientTop; w = w.parent; } } catch { crossOrigin = true; }
  return { crossOrigin, password: e.tagName === 'INPUT' && e.type === 'password', x, y,
    tag: e.tagName, role: e.getAttribute('role') || (e.tagName === 'INPUT' ? 'textbox' : e.tagName.toLowerCase()),
    name: (e.getAttribute('aria-label') || e.labels?.[0]?.innerText || e.innerText || e.getAttribute('placeholder') || '').slice(0, 200) };
}`
function targetExpression(input: BrowserActInput): string {
  const point = input.x !== undefined
  return `(() => {
    let d = document, e, x = ${JSON.stringify(input.x ?? 0)}, y = ${JSON.stringify(input.y ?? 0)};
    for (let i = 0; i < 20; i++) {
      e = ${point ? 'd.elementFromPoint(x, y)' : 'd.activeElement'};
      if (!e) throw new Error('No target element');
      while (e.shadowRoot && ${point ? 'e.shadowRoot.elementFromPoint(x, y)' : 'e.shadowRoot.activeElement'}) e = ${point ? 'e.shadowRoot.elementFromPoint(x, y)' : 'e.shadowRoot.activeElement'};
      if (e.tagName !== 'IFRAME' && e.tagName !== 'FRAME') return e;
      try {
        if (!e.contentDocument || e.contentWindow.location.origin !== window.location.origin) throw new Error('Cross-origin iframe actions are refused');
        const r = e.getBoundingClientRect(); x -= r.left + e.clientLeft; y -= r.top + e.clientTop; d = e.contentDocument;
      } catch { throw new Error('Cross-origin iframe actions are refused'); }
    }
    throw new Error('Target frame nesting is too deep');
  })()`
}
const KEYS: Record<string, { key: string; code: string; windowsVirtualKeyCode: number }> = {
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 }, Space: { key: ' ', code: 'Space', windowsVirtualKeyCode: 32 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 }, ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 }, ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  Home: { key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 }, End: { key: 'End', code: 'End', windowsVirtualKeyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', windowsVirtualKeyCode: 33 }, PageDown: { key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 },
}
export class BrowserPaneCdp {
  generation: number
  private nextRef = 0
  private refs = new Map<string, number>()
  private dialogs: string[] = []
  private accent = { r: 244, g: 114, b: 182 }
  private overlayEnabled = false
  private marked = false
  private screenshotScale: { x: number; y: number } | undefined
  constructor(private readonly deps: {
    command: BrowserCdpCommand
    url: () => string
    displayUrl?: () => Promise<string>
    capture: (maxPixels: number) => Promise<BrowserCapturedPage>
    onDialog?: (report: { type: string; message: string; accepted: boolean }) => void
    onNativeDialog?: (open: boolean) => void
    nextGeneration?: () => number
  }) { this.generation = deps.nextGeneration?.() ?? 1 }
  navigated(): void { this.generation = this.deps.nextGeneration?.() ?? this.generation + 1; this.nextRef = 0; this.refs.clear(); this.screenshotScale = undefined }
  setAccent(accent: { r: number; g: number; b: number }): void {
    if (Object.values(accent).every(value => Number.isInteger(value) && value >= 0 && value <= 255)) this.accent = { ...accent }
  }
  async clearMark(gate: BrowserDispatchGate): Promise<void> {
    if (!this.marked) return
    await this.send('Overlay.hideHighlight', {}, gate)
    this.marked = false
  }
  private async markPoint(x: number, y: number, gate: BrowserDispatchGate): Promise<void> {
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) return
    if (!this.overlayEnabled) {
      await this.send('DOM.enable', {}, gate)
      await this.send('Overlay.enable', {}, gate)
      this.overlayEnabled = true
    }
    await this.send('Overlay.highlightRect', { x: Math.max(0, Math.round(x - 7)), y: Math.max(0, Math.round(y - 7)), width: 14, height: 14,
      color: { ...this.accent, a: 0.16 }, outlineColor: { ...this.accent, a: 0.9 } }, gate)
    this.marked = true
  }
  private async send(method: string, params: any, gate: BrowserDispatchGate, sessionId?: string): Promise<any> {
    gate()
    const result = await this.deps.command(method, params, sessionId)
    gate()
    if (result?.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'Browser script failed')
    return result
  }
  async initialize(gate: BrowserDispatchGate, sessionId?: string): Promise<void> {
    await this.send('Page.enable', {}, gate, sessionId)
    await this.send('Page.setInterceptFileChooserDialog', { enabled: true }, gate, sessionId)
    await this.send('Runtime.enable', {}, gate, sessionId)
    await this.send('Runtime.addBinding', { name: BROWSER_DIALOG_BINDING }, gate, sessionId)
    await this.send('Page.addScriptToEvaluateOnNewDocument', { source: BROWSER_DIALOG_SCRIPT }, gate, sessionId)
    await this.send('Runtime.evaluate', { expression: BROWSER_DIALOG_SCRIPT }, gate, sessionId)
    await this.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, gate, sessionId)
  }
  async event(method: string, params: any, gate: BrowserDispatchGate, sessionId?: string): Promise<void> {
    if (method === 'Target.attachedToTarget') {
      const child = params.sessionId as string
      try { if (params.targetInfo?.type === 'iframe') await this.initialize(gate, child) }
      finally { await this.send('Runtime.runIfWaitingForDebugger', {}, gate, child) }
    }
    if (method === 'Page.javascriptDialogOpening') this.deps.onNativeDialog?.(true)
    if (method === 'Page.javascriptDialogClosed') this.deps.onNativeDialog?.(false)
    if (method === 'Runtime.bindingCalled' && params.name === BROWSER_DIALOG_BINDING) {
      try {
        const report = JSON.parse(params.payload)
        if (!['alert', 'confirm'].includes(report.type) || typeof report.message !== 'string') return
        const safe = { type: report.type as string, message: report.message.slice(0, 2000), accepted: report.accepted === true }
        this.dialogs.push(`${safe.type}: ${safe.message}${safe.accepted ? ' (accepted)' : ''}`)
        this.dialogs = this.dialogs.slice(-10)
        this.deps.onDialog?.(safe)
      } catch { /* A malformed page report does not alter dialog state. */ }
    }
  }
  async read(gate: BrowserDispatchGate): Promise<BrowserRequestValues['browser.read']> {
    const generation = this.generation
    const tree = await this.send('Accessibility.getFullAXTree', {}, gate)
    const textResult = await this.send('Runtime.evaluate', { expression: `document.body?.innerText?.slice(0, ${MAX_TEXT + 1}) || ''`, returnByValue: true }, gate)
    if (generation !== this.generation) throw new Error('The page changed while reading; read it again')
    if (!Array.isArray(tree.nodes) || typeof textResult.result?.value !== 'string') throw new Error('Browser read returned an invalid response')
    const nodes: any[] = tree.nodes
    let snapshot = '', truncated = nodes.length > MAX_NODES
    this.refs.clear()
    for (const node of nodes.slice(0, MAX_NODES)) {
      if (node.ignored) continue
      const role = String(node.role?.value ?? 'element').slice(0, 100)
      const name = String(node.name?.value ?? '').slice(0, 200)
      const ref = typeof node.backendDOMNodeId === 'number' ? `g${generation}r${++this.nextRef}` : ''
      const line = `${ref} ${role} ${JSON.stringify(name)}\n`
      if (snapshot.length + line.length > MAX_TEXT) { truncated = true; break }
      if (ref) this.refs.set(ref, node.backendDOMNodeId)
      snapshot += line
    }
    const raw = String(textResult.result?.value ?? '')
    truncated ||= raw.length > MAX_TEXT
    if (this.dialogs.length) snapshot += this.dialogs.splice(0).map(report => `[dialog] ${report}\n`).join('')
    if (truncated) snapshot += '[truncated]\n'
    return { url: this.deps.url(), text: raw.slice(0, MAX_TEXT), snapshot, truncated, generation }
  }
  async screenshot(gate: BrowserDispatchGate): Promise<BrowserRequestValues['browser.screenshot']> {
    const generation = this.generation
    const viewport = (await this.send('Runtime.evaluate', {
      expression: '({ width: window.innerWidth, height: window.innerHeight })', returnByValue: true,
    }, gate)).result?.value
    const image = await this.deps.capture(BROWSER_SCREENSHOT_MAX_PIXELS)
    gate()
    if (generation !== this.generation) throw new Error('The page changed while capturing; take another screenshot')
    if (!Number.isInteger(image.width) || !Number.isInteger(image.height) || image.width < 1 || image.height < 1 || image.width > 4096 || image.height > 4096 || image.width * image.height > BROWSER_SCREENSHOT_MAX_PIXELS) throw new Error('Browser screenshot exceeds the pixel limit')
    if (image.data.length > 3_900_000) throw new Error('Browser screenshot exceeds the result limit')
    if (!Number.isFinite(viewport?.width) || !Number.isFinite(viewport?.height) || viewport.width <= 0 || viewport.height <= 0) throw new Error('Browser viewport is unavailable')
    // Captures contain device pixels and may be resized again to meet the transport limit.
    this.screenshotScale = { x: viewport.width / image.width, y: viewport.height / image.height }
    return { ...image, mimeType: 'image/png' }
  }
  private cssPoint(input: BrowserActInput): BrowserActInput {
    if (input.x === undefined || input.y === undefined || !this.screenshotScale) return input
    return { ...input, x: input.x * this.screenshotScale.x, y: input.y * this.screenshotScale.y }
  }
  private async target(input: BrowserActInput, gate: BrowserDispatchGate, scrollIntoView = false): Promise<{ objectId: string; details: any }> {
    let objectId: string | undefined
    if (input.ref !== undefined) {
      const backendNodeId = this.refs.get(input.ref)
      if (!backendNodeId || !input.ref.startsWith(`g${this.generation}r`)) throw new Error('The browser ref is stale; read the page again')
      objectId = (await this.send('DOM.resolveNode', { backendNodeId }, gate)).object?.objectId
      if (objectId) {
        // AX text nodes refer to a DOM Text; actions belong to its containing element.
        objectId = (await this.send('Runtime.callFunctionOn', { objectId, functionDeclaration: 'function() { return this.nodeType === 1 ? this : this.parentElement; }' }, gate)).result?.objectId
      }
    } else {
      objectId = (await this.send('Runtime.evaluate', { expression: targetExpression(input) }, gate)).result?.objectId
    }
    if (!objectId) throw new Error('The browser target is unavailable')
    const result = await this.send('Runtime.callFunctionOn', { objectId, functionDeclaration: TARGET_DETAILS, returnByValue: true }, gate)
    let details = result.result?.value
    if (!details) throw new Error('The browser target is unavailable')
    if (details.crossOrigin) throw new Error('Cross-origin iframe actions are refused')
    if (scrollIntoView && input.ref) {
      await this.send('Runtime.callFunctionOn', { objectId, functionDeclaration: 'function() { this.scrollIntoView({ block: \"center\", inline: \"center\" }); }' }, gate)
      details = (await this.send('Runtime.callFunctionOn', { objectId, functionDeclaration: TARGET_DETAILS, returnByValue: true }, gate)).result?.value
      if (!details || details.crossOrigin) throw new Error('Cross-origin iframe actions are refused')
    }
    return { objectId, details }
  }
  private validate(input: BrowserActInput): void {
    if (input.action === 'key' && !Object.hasOwn(KEYS, input.key ?? '')) throw new Error('This browser key is not allowed')
    if ((input.text?.length ?? 0) > 16_000 || (input.value?.length ?? 0) > 4_000) throw new Error('Browser input is too long')
    if (input.action === 'scroll' && input.deltaX === undefined && input.deltaY === undefined) throw new Error('Scroll needs a delta')
  }
  private async description(input: BrowserActInput, details?: any): Promise<string> {
    const target = details ? `${details.role || 'element'} ${JSON.stringify(details.name || '')}` : 'the next confirm'
    const action = input.action === 'type' ? `type ${JSON.stringify(input.text)} into` : input.action === 'key' ? `press ${input.key} on` : input.action === 'select' ? `select ${JSON.stringify(input.value)} in` : input.action === 'acceptConfirm' ? 'accept' : input.action
    const description = `${action} ${target} on ${await this.deps.displayUrl?.() ?? this.deps.url()}`
    return description.length > 7800 ? `${description.slice(0, 7780)} [truncated]` : description
  }
  async describe(input: BrowserDescribeInput, gate: BrowserDispatchGate): Promise<BrowserRequestValues['browser.describe']> {
    let description: string
    if (input.operation === 'act') {
      const act = this.cssPoint(input.act!)
      this.validate(act)
      const target = act.action === 'acceptConfirm' ? undefined : await this.target(act, gate)
      if (target?.details.password && (act.action === 'type' || act.action === 'key')) throw new Error('Typing into password fields is refused; take over to type it')
      description = await this.description(act, target?.details)
    } else if (input.operation === 'navigate') description = input.navigate!.action === 'navigate' ? `navigate to ${input.navigate!.target}` : `${input.navigate!.action} on ${await this.deps.displayUrl?.() ?? this.deps.url()}`
    else description = `${input.operation} on ${await this.deps.displayUrl?.() ?? this.deps.url()}`
    gate()
    return { description: description.slice(0, 8192), url: this.deps.url() }
  }
  async act(input: BrowserActInput, gate: BrowserDispatchGate): Promise<BrowserRequestValues['browser.act']> {
    input = this.cssPoint(input)
    this.validate(input)
    let description: string
    if (input.action === 'acceptConfirm') {
      await this.send('Runtime.evaluate', { expression: BROWSER_ARM_CONFIRM_SCRIPT }, gate)
      description = await this.description(input)
    } else {
      const generation = this.generation
      const target = await this.target(input, gate, input.action === 'click' || input.action === 'scroll')
      if (target.details.password && (input.action === 'type' || input.action === 'key')) throw new Error('Typing into password fields is refused; take over to type it')
      description = await this.description(input, target.details)
      const x = input.x ?? target.details.x, y = input.y ?? target.details.y
      let markX = x, markY = y
      if ((input.action === 'click' || input.action === 'scroll') && (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0)) throw new Error('The browser target has no usable point')
      const actionGate = () => { gate(); if (generation !== this.generation) throw new Error('The page changed before the action completed') }
      const dispatch = (method: string, params: any) => { actionGate(); return this.send(method, params, gate) }
      if (input.action === 'click') {
        await dispatch('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
        await dispatch('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
      } else if (input.action === 'scroll') {
        await dispatch('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: input.deltaX ?? 0, deltaY: input.deltaY ?? 0 })
      } else {
        await dispatch('Runtime.callFunctionOn', { objectId: target.objectId, functionDeclaration: 'function() { this.focus(); }' })
        // Focusing can run page code. Inspect the actual focused field before any typing.
        const focused = await this.target({ action: input.action }, actionGate)
        markX = focused.details.x; markY = focused.details.y
        if (focused.details.password && (input.action === 'type' || input.action === 'key')) throw new Error('Typing into password fields is refused; take over to type it')
        if (input.action === 'type') await dispatch('Input.insertText', { text: input.text })
        if (input.action === 'key') {
          const key = KEYS[input.key!]!
          await dispatch('Input.dispatchKeyEvent', { type: 'keyDown', ...key, ...(input.key === 'Enter' ? { text: '\r' } : input.key === 'Space' ? { text: ' ' } : {}) })
          await dispatch('Input.dispatchKeyEvent', { type: 'keyUp', ...key })
        }
        if (input.action === 'select') await dispatch('Runtime.callFunctionOn', { objectId: target.objectId, functionDeclaration: `function(value) { if (this.tagName !== 'SELECT') throw new Error('Target is not a select'); if (![...this.options].some(o => o.value === value)) throw new Error('Select value is unavailable'); this.value = value; this.dispatchEvent(new Event('input', { bubbles: true })); this.dispatchEvent(new Event('change', { bubbles: true })); }`, arguments: [{ value: input.value }] })
      }
      if (generation === this.generation) await this.markPoint(markX, markY, gate)
    }
    if (this.dialogs.length) description += `; ${this.dialogs.splice(0).join('; ')}`
    return { url: this.deps.url(), description: description.length > 8192 ? `${description.slice(0, 8170)} [truncated]` : description }
  }
}
