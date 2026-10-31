import { createHash } from 'node:crypto'
import type { Debugger } from 'electron'
import { normalizeLocalhostPreviewUrl } from '../shared/filePreview.js'

export interface LocalhostSnapshotBinding {
  id: string
  appSessionId: string
  frameName: string
  url: string
}
export interface LocalhostSnapshotFrame {
  readonly detached?: boolean
  isDestroyed?(): boolean
  name: string
  url: string
  parent: { parent: unknown | null } | null
  executeJavaScript(code: string): Promise<unknown>
}
export interface LocalhostSnapshotResource { mimeType: string; body: Buffer }
export interface LocalhostFrozenSnapshot {
  id: string
  appSessionId: string
  sourceUrl: string
  html: string
  resources: ReadonlyMap<string, LocalhostSnapshotResource>
  byteLength: number
}
export interface LocalhostSnapshotLimits {
  totalBytes: number
  resourceBytes: number
  resourcesPerPreview: number
  snapshots: number
  pendingRequests: number
  bodyReads: number
  queuedBodyReads: number
  captures: number
  captureTimeoutMs: number
  htmlBytes: number
  domNodes: number
}
type DebuggerTransport = Pick<Debugger, 'isAttached' | 'attach' | 'detach' | 'on' | 'removeListener' | 'sendCommand'>
type FrameTree = { frame: { id: string; parentId?: string; name?: string; url: string }; childFrames?: FrameTree[] }
type RequestRecord = {
  key: string; requestId: string; sessionId?: string; frameId: string; url: string
  received: number; oversized: boolean; mimeType: string | null; success: boolean
}
const DEFAULTS: LocalhostSnapshotLimits = {
  totalBytes: 128 * 1024 * 1024, resourceBytes: 16 * 1024 * 1024, resourcesPerPreview: 128,
  snapshots: 256, pendingRequests: 256, bodyReads: 2, queuedBodyReads: 32, captures: 4,
  captureTimeoutMs: 600, htmlBytes: 8 * 1024 * 1024, domNodes: 4_000,
}
function closedDebuggerTarget(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 256)
  return /^(?:target closed while handling command|session with given id not found\.?|session closed\.?|target closed\.?)$/i.test(message)
}
function withoutHash(value: string): string {
  try { const url = new URL(value); url.hash = ''; return url.href } catch { return value }
}
function cssWithLocalResources(css: string, base: string, assets: Map<string, string>): string {
  return css.replace(/@import\s+(?:url\([^)]*\)|["'][^"']*["'])[^;]*;/gi, '')
    .replace(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi, (_all, double, single, bare) => {
      const raw = String(double ?? single ?? bare ?? '').trim()
      if (raw.startsWith('#') || raw.startsWith('data:')) return `url(${JSON.stringify(raw)})`
      try {
        const url = new URL(raw, base)
        const resource = assets.get(withoutHash(url.href))
        return resource ? `url(${JSON.stringify(resource + url.hash)})` : 'url("data:,")'
      } catch { return 'url("data:,")' }
    })
}
function freezeExpression(assets: Map<string, string>, stylesheets: Map<string, string>, limits: LocalhostSnapshotLimits, expectedUrl: string): string {
  // The expression runs only in the independently authorized preview frame.
  return `(() => {
    if (location.href !== ${JSON.stringify(expectedUrl)}) return null;
    const assets = ${JSON.stringify(Object.fromEntries(assets))};
    const sheets = ${JSON.stringify(Object.fromEntries(stylesheets))};
    const deadline = performance.now() + ${Math.max(50, limits.captureTimeoutMs - 50)};
    const original = [document.documentElement];
    const elements = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_ELEMENT);
    let element; while ((element = elements.nextNode())) { if (original.length >= ${limits.domNodes}) return null; original.push(element); }
    let budget = 0;
    const texts = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_TEXT);
    let text; while ((text = texts.nextNode())) { budget += text.length; if (budget > ${Math.floor(limits.htmlBytes / 3)}) return null; }
    for (const source of original) {
      if (source.attributes.length > 100) return null;
      for (const attribute of source.attributes) { if (attribute.value.length > 8192) return null; budget += attribute.value.length; }
      if (budget > ${Math.floor(limits.htmlBytes / 3)}) return null;
    }
    const root = document.documentElement.cloneNode(true);
    const cloned = [root, ...root.querySelectorAll('*')];
    const resolve = raw => {
      if (!raw) return 'data:,';
      if (raw[0] === '#' || raw.startsWith('data:')) return raw;
      try { const url = new URL(raw, document.baseURI); const hash = url.hash; url.hash = ''; return assets[url.href] ? assets[url.href] + hash : 'data:,'; } catch { return 'data:,'; }
    };
    const css = value => value.replace(/url\\(\\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\\s*\\)/gi, (_all, a, b, c) => 'url(' + JSON.stringify(resolve((a ?? b ?? c ?? '').trim())) + ')');
    const properties = ['display','position','top','right','bottom','left','z-index','width','height','min-width','min-height','max-width','max-height','box-sizing','margin','padding','border','border-radius','box-shadow','background','background-image','background-size','background-position','background-repeat','background-clip','color','opacity','font','font-family','font-size','font-weight','font-style','font-feature-settings','line-height','letter-spacing','word-spacing','white-space','text-align','text-decoration','text-transform','text-indent','vertical-align','overflow','overflow-x','overflow-y','overflow-wrap','word-break','float','clear','flex','flex-direction','flex-wrap','align-items','align-self','justify-content','gap','grid-template-columns','grid-template-rows','grid-column','grid-row','object-fit','object-position','transform','transform-origin','filter','clip-path','list-style','border-collapse','table-layout','fill','stroke','stroke-width'];
    const styleNode = document.createElement('style');
    const fontFaces = Object.values(sheets).flatMap(text => text.match(/@font-face\\s*\\{[^}]*\\}/gi) || []).join('\\n').replace(/</g, () => String.fromCharCode(92) + '3c ');
    styleNode.textContent = fontFaces + '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}';
    for (let i = 0; i < original.length; i++) {
      if (performance.now() > deadline) return null;
      const source = original[i], target = cloned[i];
      if (!target) return null;
      for (const attribute of [...target.attributes]) {
        if (/^on/i.test(attribute.name) || ['srcdoc','autofocus','contenteditable','formaction','action','ping','nonce','integrity'].includes(attribute.name.toLowerCase())) target.removeAttribute(attribute.name);
      }
      if (target.hasAttribute('style')) target.setAttribute('style', css(target.getAttribute('style')));
      const computed = getComputedStyle(source);
      for (const property of properties) { const value = computed.getPropertyValue(property); if (value && value.length <= 8192) { budget += value.length; if (budget > ${Math.floor(limits.htmlBytes / 3)}) return null; target.style.setProperty(property, css(value)); } }
      if (source instanceof HTMLImageElement) {
        let src = resolve(source.currentSrc || source.src);
        if (src === 'data:,' && source.complete && source.naturalWidth && source.naturalWidth * source.naturalHeight <= 1048576) {
          try { const canvas = document.createElement('canvas'); canvas.width = source.naturalWidth; canvas.height = source.naturalHeight; canvas.getContext('2d').drawImage(source, 0, 0); const data = canvas.toDataURL('image/png'); if (data.length <= 2097152) src = data; } catch {}
        }
        target.setAttribute('src', src); target.removeAttribute('srcset'); target.removeAttribute('loading');
      }
      else if (source instanceof HTMLInputElement) { target.setAttribute('value', source.value); if (source.checked) target.setAttribute('checked', ''); else target.removeAttribute('checked'); }
      else if (source instanceof HTMLTextAreaElement) target.textContent = source.value;
      else if (source instanceof HTMLOptionElement) { if (source.selected) target.setAttribute('selected', ''); else target.removeAttribute('selected'); }
      if (source.tagName === 'CANVAS' || source.tagName === 'VIDEO') {
        try {
          const width = source.width || source.videoWidth, height = source.height || source.videoHeight;
          if (!width || !height || width * height > 1048576) { target.remove(); continue; }
          const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
          canvas.getContext('2d').drawImage(source, 0, 0, width, height);
          const data = canvas.toDataURL('image/png');
          if (data.length > 2097152) { target.remove(); continue; }
          const image = document.createElement('img'); image.src = data; image.setAttribute('style', target.getAttribute('style') || ''); target.replaceWith(image);
        } catch { target.remove(); }
      }
      if (source instanceof HTMLLinkElement) {
        if (source.relList.contains('stylesheet')) {
          let contents = sheets[source.href] || '';
          if (!contents) { try { for (const rule of source.sheet?.cssRules || []) { if (contents.length + rule.cssText.length > 1048576) { contents = ''; break; } contents += rule.cssText; } contents = css(contents); } catch {} }
          if (contents) { const style = document.createElement('style'); style.textContent = contents.replace(/</g, () => String.fromCharCode(92) + '3c '); target.replaceWith(style); }
          else target.remove();
        } else target.remove();
      }
      if (source.tagName === 'STYLE') target.textContent = css(source.textContent || '').replace(/</g, () => String.fromCharCode(92) + '3c ');
      if (source.localName === 'a' || source.localName === 'area') { target.removeAttribute('href'); target.removeAttribute('target'); }
      for (const name of ['href','xlink:href']) {
        const value = target.getAttribute(name);
        if (value && source.localName !== 'a' && source.localName !== 'area') target.setAttribute(name, resolve(value));
      }
    }
    root.querySelectorAll('script,noscript,iframe,frame,frameset,object,embed,portal,base,meta[http-equiv],audio,source,track').forEach(node => node.remove());
    root.querySelectorAll('form').forEach(node => { node.removeAttribute('action'); node.setAttribute('inert',''); });
    const head = root.querySelector('head'); if (head) head.append(styleNode);
    const html = '<!doctype html>' + root.outerHTML;
    return html.length <= ${Math.floor(limits.htmlBytes / 3)} ? html : null;
  })()`
}

/** Passive response observation. Captured bytes never enter a model prompt. */
export function createLocalhostSnapshots(options: {
  debugger: DebuggerTransport
  bindings: () => readonly LocalhostSnapshotBinding[]
  devOrigin?: string | null
  limits?: Partial<LocalhostSnapshotLimits>
}) {
  const limits = { ...DEFAULTS, ...options.limits }
  const transport = options.debugger
  const requests = new Map<string, RequestRecord>()
  const frames = new Map<string, LocalhostSnapshotBinding>()
  const resources = new Map<string, Map<string, LocalhostSnapshotResource>>()
  const snapshots = new Map<string, LocalhostFrozenSnapshot>()
  const latestSnapshot = new Map<string, string>()
  const pendingCaptures = new Map<string, Promise<boolean>>()
  const queue: RequestRecord[] = []
  const sessions = new Set<string>()
  const sessionSetup = new Map<string, Promise<void>>()
  const sessionOrder = new Map<string, number>()
  const deferredTargets = new Map<string, { handle: ReturnType<typeof setImmediate>; resolve: () => void; pending: Promise<void> }>()
  let deferredStop: ReturnType<typeof setImmediate> | null = null
  let observerGeneration = 0, nextSessionOrder = 0
  const networkSessions = new Set<string>()
  const frameSessions = new Map<string, string>()
  const sessionRoots = new Map<string, FrameTree['frame']>()
  let mainTree: FrameTree | null = null
  let rootFrameId = '', activeReads = 0, started = false, attached = false, disposed = false
  let refreshPending: Promise<void> | null = null
  let startPending: Promise<boolean> | null = null
  const commands = new Map<Promise<unknown>, string>()
  const nativeAcknowledgements = new Set<Promise<unknown>>()
  const childCommands = new Map<string, { sessionId: string; resolve: (value: unknown) => void; reject: (error: unknown) => void }>()
  let nextChildRequest = 0
  const sendChildCommand = (method: string, params: Record<string, unknown>, sessionId: string): Promise<unknown> => {
    const requestId = ++nextChildRequest
    const key = `${sessionId}:${requestId}`
    let resolve!: (value: unknown) => void, reject!: (error: unknown) => void
    const pending = new Promise<unknown>((done, fail) => { resolve = done; reject = fail })
    childCommands.set(key, { sessionId, resolve, reject })
    const fail = (error: unknown) => { if (childCommands.delete(key)) reject(error) }
    try {
      // Electron retains native child-command promises if a process swap eats
      // their replies. A root acknowledgement stays separate from our bounded,
      // session-scoped replies, which can be retired when that child detaches.
      const acknowledgement = transport.sendCommand('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id: requestId, method, params }) })
      nativeAcknowledgements.add(acknowledgement)
      void acknowledgement.then(() => nativeAcknowledgements.delete(acknowledgement), error => { nativeAcknowledgements.delete(acknowledgement); fail(error) })
    } catch (error) { fail(error) }
    return pending
  }
  const leases = new Map<string, { token: symbol; id: string; appSessionId: string; frameId: string; sessionId?: string }>()
  const leaseFor = (key: string, binding: LocalhostSnapshotBinding, frameId: string, sessionId?: string) => {
    let lease = leases.get(key)
    if (!lease) { lease = { token: Symbol(key), id: binding.id, appSessionId: binding.appSessionId, frameId, sessionId }; leases.set(key, lease) }
    return lease
  }
  const ownOrigin = (() => { try { return options.devOrigin ? new URL(options.devOrigin).origin : null } catch { return null } })()
  const currentBinding = (id: string, frameName: string) => options.bindings().find(item => item.id === id && item.frameName === frameName)
  const generationKey = (binding: LocalhostSnapshotBinding, frameId: string, sessionId?: string) => `${binding.id}:${binding.frameName}:${frameId}:${sessionId ?? ''}`
  const isOwnUrl = (url: string) => { try { return new URL(url).origin === ownOrigin } catch { return true } }
  const retainedBytes = () => {
    const buffers = new Set<Buffer>()
    let bytes = 0
    for (const group of resources.values()) for (const resource of group.values()) buffers.add(resource.body)
    for (const snapshot of snapshots.values()) {
      bytes += Buffer.byteLength(snapshot.html)
      for (const resource of snapshot.resources.values()) buffers.add(resource.body)
    }
    for (const body of buffers) bytes += body.byteLength
    return bytes
  }
  const deleteSnapshot = (key: string) => {
    snapshots.delete(key)
    for (const [id, latest] of latestSnapshot) if (latest === key) latestSnapshot.delete(id)
  }
  const evictFor = (bytes: number) => {
    while (snapshots.size && (retainedBytes() + bytes > limits.totalBytes || snapshots.size >= limits.snapshots)) deleteSnapshot(snapshots.keys().next().value!)
    return retainedBytes() + bytes <= limits.totalBytes
  }
  const command = (method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> => {
    const count = (name: string) => [...commands.values()].filter(value => value === name).length
    if (disposed || commands.size + nativeAcknowledgements.size >= 16 || method === 'Network.getResponseBody' && count(method) >= limits.bodyReads || method === 'Runtime.evaluate' && count(method) >= limits.captures) return Promise.reject(new Error('Snapshot command capacity exceeded')) // §7-ok: Internal debugger rejection is caught before the UI boundary.
    let pending: Promise<any>
    try { pending = sessionId ? sendChildCommand(method, params, sessionId) : transport.sendCommand(method, params) } catch (error) { return Promise.reject(error) }
    commands.set(pending, method)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Snapshot command timed out')), limits.captureTimeoutMs) // §7-ok: Internal debugger rejection is caught before the UI boundary.
      pending.then(value => { clearTimeout(timer); commands.delete(pending); resolve(value) }, error => { clearTimeout(timer); commands.delete(pending); reject(error) })
    })
  }
  const bindingForFrame = (frame: FrameTree['frame'], allowPending = false) => {
    const binding = options.bindings().find(item => item.frameName === frame.name && normalizeLocalhostPreviewUrl(item.url) && !isOwnUrl(item.url))
    if (!binding || frame.parentId !== rootFrameId) return null
    if (allowPending && ['', ':', 'about:blank'].includes(frame.url)) return binding
    return normalizeLocalhostPreviewUrl(frame.url) && !isOwnUrl(frame.url) && new URL(frame.url).origin === new URL(binding.url).origin ? binding : null
  }
  const mapFrames = () => {
    frames.clear()
    for (const frame of [...(mainTree?.childFrames ?? []).map(child => child.frame), ...[...sessionRoots].filter(([sessionId, frame]) => frameSessions.get(frame.id) === sessionId).map(([, frame]) => frame)]) {
      const binding = bindingForFrame(frame)
      if (binding) frames.set(frame.id, binding)
    }
  }
  const refreshFrames = (): Promise<void> => {
    if (refreshPending) return refreshPending
    const generation = observerGeneration
    const pending = command('Page.getFrameTree').then(raw => {
      if (disposed || generation !== observerGeneration) return
      const tree = (raw as { frameTree?: FrameTree }).frameTree
      if (!tree) return
      mainTree = { frame: tree.frame, childFrames: (tree.childFrames ?? []).slice(0, 16).map(child => ({ frame: child.frame })) }
      rootFrameId = tree.frame.id
      mapFrames()
    }).catch(() => {}).finally(() => { if (refreshPending === pending) refreshPending = null })
    refreshPending = pending
    return pending
  }
  const finishRead = async (request: RequestRecord) => {
    const generation = observerGeneration
    try {
      if (request.sessionId) await sessionSetup.get(request.sessionId)
      if (generation !== observerGeneration || request.sessionId && !sessions.has(request.sessionId)) return
      await refreshFrames()
      if (generation !== observerGeneration || frameSessions.get(request.frameId) !== request.sessionId) return
      const binding = frames.get(request.frameId)
      if (!binding || !currentBinding(binding.id, binding.frameName) || request.oversized || request.received <= 0 || request.received > limits.resourceBytes || !request.success || !request.mimeType || isOwnUrl(request.url)) return
      const key = generationKey(binding, request.frameId, request.sessionId)
      const lease = leaseFor(key, binding, request.frameId, request.sessionId)
      const raw = await command('Network.getResponseBody', { requestId: request.requestId }, request.sessionId) as { body?: unknown; base64Encoded?: unknown }
      if (disposed || generation !== observerGeneration || frameSessions.get(request.frameId) !== request.sessionId || !currentBinding(binding.id, binding.frameName) || leases.get(key) !== lease || typeof raw.body !== 'string') return
      if (raw.base64Encoded === true && raw.body.length > Math.ceil(limits.resourceBytes / 3) * 4 + 4 || raw.base64Encoded !== true && Buffer.byteLength(raw.body) > limits.resourceBytes) return
      const body = Buffer.from(raw.body, raw.base64Encoded === true ? 'base64' : 'utf8')
      if (body.byteLength > limits.resourceBytes || !evictFor(body.byteLength)) return
      let group = resources.get(key)
      if (!group) { group = new Map(); resources.set(key, group) }
      const url = withoutHash(request.url)
      if (group.size >= limits.resourcesPerPreview && !group.has(url)) return
      group.set(url, { mimeType: request.mimeType, body })
    } catch { /* Detached or evicted response bodies are unavailable to the snapshot. */ }
  }
  const drain = () => {
    while (!disposed && activeReads < limits.bodyReads && queue.length) {
      const request = queue.shift()!
      activeReads++
      void finishRead(request).finally(() => { activeReads--; drain() })
    }
  }
  const resumeSession = async (sessionId: string, generation = observerGeneration) => {
    if (disposed || generation !== observerGeneration || !attached) return
    try { await command('Runtime.runIfWaitingForDebugger', {}, sessionId) }
    catch (error) {
      if (generation !== observerGeneration) return
      if (closedDebuggerTarget(error)) { forgetSession(sessionId); return }
      if (!sessions.has(sessionId)) return
      requestDeferredStop(generation)
    }
  }
  const configureSession = async (sessionId?: string, generation = observerGeneration, waitingForDebugger = false) => {
    const key = sessionId ?? ''
    let admitted = false
    try {
      if (!networkSessions.has(key) && networkSessions.size >= 4) return
      networkSessions.add(key)
      // Start the Network agent before Page/frame-tree round trips can miss the
      // new renderer's first subresource loads. No body is read before binding.
      await Promise.all([
        command('Network.enable', { maxTotalBufferSize: Math.floor(limits.totalBytes / 4), maxResourceBufferSize: Math.min(limits.resourceBytes, Math.floor(limits.totalBytes / 4)), maxPostDataSize: 0 }, sessionId),
        command('Page.enable', {}, sessionId),
      ])
      if (generation !== observerGeneration || !attached || sessionId && !sessions.has(sessionId)) return
      if (sessionId) {
        const frame = (await command('Page.getFrameTree', {}, sessionId) as { frameTree?: FrameTree }).frameTree?.frame
        if (generation !== observerGeneration || !sessions.has(sessionId) || !frame || !bindingForFrame(frame, true)) return
        rememberSessionFrame(sessionId, frame)
      }
      admitted = true
      await refreshFrames()
    } finally {
      if (generation === observerGeneration) {
        if (!admitted) { networkSessions.delete(key); if (sessionId && attached && sessions.has(sessionId)) await command('Network.disable', {}, sessionId).catch(() => {}) }
        if (sessionId && waitingForDebugger && sessions.has(sessionId)) await resumeSession(sessionId, generation)
      }
    }
  }
  const rememberSessionFrame = (sessionId: string, frame: FrameTree['frame']) => {
    sessionRoots.set(sessionId, frame)
    const previous = frameSessions.get(frame.id)
    if (!previous || (sessionOrder.get(previous) ?? 0) <= (sessionOrder.get(sessionId) ?? 0)) frameSessions.set(frame.id, sessionId)
    mapFrames()
  }
  const dropGeneration = (frameId: string, sessionId?: string) => {
    for (const [key, lease] of leases) if (lease.frameId === frameId && lease.sessionId === sessionId) { leases.delete(key); resources.delete(key) }
    for (const [key, request] of requests) if (request.frameId === frameId && request.sessionId === sessionId) requests.delete(key)
    for (let index = queue.length - 1; index >= 0; index--) if (queue[index].frameId === frameId && queue[index].sessionId === sessionId) queue.splice(index, 1)
  }
  const requestDeferredStop = (generation: number) => {
    if (deferredStop) return
    deferredStop = setImmediate(() => {
      deferredStop = null
      if (!disposed && generation === observerGeneration) stopObserver()
    })
  }
  const deferTarget = (sessionId: string, setup: boolean, waitingForDebugger: boolean): Promise<void> => {
    const existing = deferredTargets.get(sessionId)
    if (existing) return existing.pending
    const generation = observerGeneration
    if (deferredTargets.size >= 16) { requestDeferredStop(generation); return Promise.resolve() }
    let resolve!: () => void
    const pending = new Promise<void>(done => { resolve = done })
    // Native target attachment finishes after its event returns. A macrotask
    // keeps control commands from re-entering that unfinished attachment.
    const handle = setImmediate(() => {
      deferredTargets.delete(sessionId)
      if (disposed || !attached || generation !== observerGeneration || setup && !sessions.has(sessionId)) { resolve(); return }
      const work = setup ? configureSession(sessionId, generation, waitingForDebugger) : waitingForDebugger ? resumeSession(sessionId, generation) : Promise.resolve()
      void work.catch(() => {}).finally(resolve)
    })
    deferredTargets.set(sessionId, { handle, resolve, pending })
    return pending
  }
  const forgetSession = (detachedSession: string) => {
    for (const [key, child] of childCommands) if (child.sessionId === detachedSession) { childCommands.delete(key); child.reject(new Error('Preview is unavailable')) }
    const root = sessionRoots.get(detachedSession)
    if (root) dropGeneration(root.id, detachedSession)
    for (const lease of [...leases.values()]) if (lease.sessionId === detachedSession) dropGeneration(lease.frameId, detachedSession)
    const deferred = deferredTargets.get(detachedSession)
    if (deferred) { clearImmediate(deferred.handle); deferredTargets.delete(detachedSession); deferred.resolve() }
    sessions.delete(detachedSession)
    sessionOrder.delete(detachedSession)
    networkSessions.delete(detachedSession)
    sessionRoots.delete(detachedSession)
    for (const [id, owner] of frameSessions) if (owner === detachedSession) frameSessions.delete(id)
    for (const [key, request] of requests) if (request.sessionId === detachedSession) requests.delete(key)
    mapFrames()
  }
  const onMessage = (_event: unknown, method: string, raw: unknown, sessionId?: string) => {
    if (disposed || !raw || typeof raw !== 'object' || Array.isArray(raw)) return
    sessionId = sessionId || undefined
    const params = raw as Record<string, any>
    if (method === 'Target.receivedMessageFromTarget') {
      const childSession = params.sessionId
      const maximumMessage = Math.max(65_536, Math.ceil(limits.resourceBytes / 3) * 4 + 65_536, limits.htmlBytes * 2)
      if (typeof childSession !== 'string' || typeof params.message !== 'string' || params.message.length > maximumMessage) return
      let message: Record<string, unknown>
      try {
        const parsed = JSON.parse(params.message)
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return
        message = parsed
      } catch { return }
      if (Number.isSafeInteger(message.id)) {
        const key = `${childSession}:${message.id}`
        const child = childCommands.get(key)
        if (!child) return
        childCommands.delete(key)
        const error = message.error as { message?: unknown } | undefined
        if (error) child.reject(new Error(typeof error.message === 'string' ? error.message.slice(0, 256) : 'Preview is unavailable'))
        else child.resolve(message.result ?? {})
      } else if (sessions.has(childSession) && typeof message.method === 'string') onMessage(null, message.method, message.params, childSession)
      return
    }
    if (method === 'Target.attachedToTarget') {
      const childSession = params.sessionId
      if (typeof childSession !== 'string' || params.targetInfo?.type !== 'iframe') return
      if (sessions.has(childSession)) return
      if (sessions.size >= 16) { void deferTarget(childSession, false, params.waitingForDebugger === true); return }
      sessions.add(childSession)
      sessionOrder.set(childSession, ++nextSessionOrder)
      const setup = deferTarget(childSession, true, params.waitingForDebugger === true).finally(() => { if (sessionSetup.get(childSession) === setup) sessionSetup.delete(childSession) })
      sessionSetup.set(childSession, setup)
      return
    }
    if (method === 'Target.detachedFromTarget') {
      if (typeof params.sessionId === 'string') forgetSession(params.sessionId)
      return
    }
    if (method === 'Page.frameNavigated' && sessionId && sessions.has(sessionId) && params.frame?.parentId === rootFrameId) rememberSessionFrame(sessionId, params.frame)
    if (method === 'Page.frameDetached' && params.reason !== 'swap') {
      const owner = frameSessions.get(params.frameId)
      if (!sessionId || owner === sessionId) {
        dropGeneration(params.frameId, owner)
        for (const [key, frame] of sessionRoots) if (frame.id === params.frameId && (!sessionId || key === sessionId)) sessionRoots.delete(key)
        frameSessions.delete(params.frameId)
        if (mainTree?.childFrames) mainTree.childFrames = mainTree.childFrames.filter(child => child.frame.id !== params.frameId)
        mapFrames()
      }
    }
    if (method === 'Page.frameNavigated' || method === 'Page.frameAttached' || method === 'Page.frameDetached') { void refreshFrames(); return }
    const requestId = params.requestId
    if (typeof requestId !== 'string') return
    const key = `${sessionId ?? ''}:${requestId}`
    if (method === 'Network.requestWillBeSent') {
      if (requests.size >= limits.pendingRequests || typeof params.frameId !== 'string' || params.frameId === rootFrameId || params.request?.method !== 'GET' || typeof params.request?.url !== 'string' || params.request.url.length > 4096 || !/^https?:/.test(params.request.url) || isOwnUrl(params.request.url)) return
      requests.set(key, { key, requestId, sessionId, frameId: params.frameId, url: params.request.url, received: 0, oversized: false, mimeType: null, success: false })
      return
    }
    const request = requests.get(key)
    if (!request) return
    if (method === 'Network.responseReceived') {
      request.mimeType = typeof params.response?.mimeType === 'string' && params.response.mimeType.length <= 256 ? params.response.mimeType : null
      const mime = request.mimeType?.toLowerCase() ?? ''
      const staticResource = params.type === 'Stylesheet' && mime === 'text/css' || params.type === 'Image' && mime.startsWith('image/') || params.type === 'Font' && /^(?:font\/|application\/(?:font-|x-font-|vnd\.ms-fontobject|octet-stream))/.test(mime)
      request.success = params.response?.status >= 200 && params.response.status < 300 && staticResource
    } else if (method === 'Network.dataReceived') {
      const bytes = params.dataLength
      if (!Number.isSafeInteger(bytes) || bytes < 0) request.oversized = true
      else { request.received += bytes; if (request.received > limits.resourceBytes) request.oversized = true }
    } else if (method === 'Network.loadingFailed') requests.delete(key)
    else if (method === 'Network.loadingFinished') {
      requests.delete(key)
      if (!request.oversized && request.success && queue.length < limits.queuedBodyReads) { queue.push(request); drain() }
    }
  }
  const timed = async <T>(promise: Promise<T>, fallback: T): Promise<T> => new Promise(resolve => {
    const timer = setTimeout(() => resolve(fallback), limits.captureTimeoutMs)
    promise.then(value => { clearTimeout(timer); resolve(value) }, () => { clearTimeout(timer); resolve(fallback) })
  })
  const stopObserver = () => {
    observerGeneration++
    if (deferredStop) { clearImmediate(deferredStop); deferredStop = null }
    for (const deferred of deferredTargets.values()) { clearImmediate(deferred.handle); deferred.resolve() }
    deferredTargets.clear()
    refreshPending = null; startPending = null
    started = false
    transport.removeListener('message', onMessage)
    if (attached) { try { transport.detach() } catch {} attached = false }
    for (const child of childCommands.values()) child.reject(new Error('Preview is unavailable'))
    childCommands.clear(); nativeAcknowledgements.clear()
    requests.clear(); frames.clear(); resources.clear(); queue.length = 0
    sessions.clear(); sessionSetup.clear(); sessionOrder.clear(); networkSessions.clear(); frameSessions.clear(); sessionRoots.clear(); leases.clear(); commands.clear()
    mainTree = null; rootFrameId = ''
  }
  const releaseLive = (id: string): void => {
    for (const [key, lease] of leases) if (lease.id === id) { leases.delete(key); resources.delete(key) }
    for (const [key, request] of requests) if (frames.get(request.frameId)?.id === id) requests.delete(key)
    for (let index = queue.length - 1; index >= 0; index--) if (frames.get(queue[index].frameId)?.id === id) queue.splice(index, 1)
    for (const [frameId, owner] of frames) if (owner.id === id) frames.delete(frameId)
    if (options.bindings().length === 0) stopObserver()
  }
  return {
    async start(): Promise<boolean> {
      if (started) return true
      if (startPending) return timed(startPending, false)
      if (disposed || transport.isAttached()) return false
      const generation = observerGeneration
      const pending = (async () => {
        try {
          transport.attach('1.3'); attached = true
          transport.on('message', onMessage)
          await configureSession(undefined, generation)
          if (generation !== observerGeneration || !attached) return false
          await command('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: false, filter: [{ type: 'iframe', exclude: false }, { exclude: true }] })
          if (generation !== observerGeneration || !attached) return false
          started = true
          return true
        } catch {
          if (generation === observerGeneration) stopObserver()
          return false
        }
      })().finally(() => { if (startPending === pending) startPending = null })
      startPending = pending
      return timed(pending, false)
    },
    async capture(id: string, frame: LocalhostSnapshotFrame): Promise<boolean> {
      let frameName: string, sourceUrl: string
      try {
        if (frame.isDestroyed?.() || frame.detached) return false
        const parent = frame.parent
        if (!parent || parent.parent !== null) return false
        frameName = frame.name
        sourceUrl = frame.url
      } catch { return false }
      const captureKey = `${id}:${frameName}`
      const existing = pendingCaptures.get(captureKey)
      if (existing) return timed(existing, false)
      const binding = currentBinding(id, frameName)
      if (disposed || !started || !binding || !normalizeLocalhostPreviewUrl(sourceUrl) || isOwnUrl(sourceUrl) || new URL(sourceUrl).origin !== new URL(binding.url).origin || pendingCaptures.size >= limits.captures) return false
      const pending = (async () => {
        await refreshFrames()
        const cdpFrameId = [...frames].find(([, owner]) => owner.id === id && owner.frameName === frameName)?.[0]
        if (!cdpFrameId) return false
        const sessionId = frameSessions.get(cdpFrameId)
        const key = generationKey(binding, cdpFrameId, sessionId)
        const lease = leaseFor(key, binding, cdpFrameId, sessionId)
        const group = resources.get(key) ?? new Map<string, LocalhostSnapshotResource>()
        const assets = new Map<string, string>()
        const frozenResources = new Map<string, LocalhostSnapshotResource>()
        for (const [url, resource] of group) {
          const hash = createHash('sha256').update(resource.body).digest('hex')
          assets.set(url, `asset/${hash}`); frozenResources.set(hash, resource)
        }
        const stylesheets = new Map<string, string>()
        let stylesheetBytes = 0
        for (const [url, resource] of group) if (resource.mimeType.toLowerCase().includes('css') && stylesheetBytes + resource.body.byteLength <= limits.htmlBytes / 2) {
          stylesheetBytes += resource.body.byteLength
          stylesheets.set(url, cssWithLocalResources(resource.body.toString('utf8'), url, assets))
        }
        const world = await command('Page.createIsolatedWorld', { frameId: cdpFrameId, worldName: 'cat-preview-snapshot', grantUniveralAccess: false }, sessionId) as { executionContextId?: number }
        if (!Number.isSafeInteger(world.executionContextId)) return false
        const evaluated = await command('Runtime.evaluate', { expression: freezeExpression(assets, stylesheets, limits, sourceUrl), contextId: world.executionContextId, returnByValue: true, timeout: limits.captureTimeoutMs }, sessionId) as { result?: { type?: string; value?: unknown }; exceptionDetails?: unknown }
        const html = !evaluated.exceptionDetails && evaluated.result?.type === 'string' ? evaluated.result.value : null
        if (disposed || leases.get(key) !== lease || !currentBinding(id, frameName) || typeof html !== 'string' || Buffer.byteLength(html) > limits.htmlBytes || !evictFor(Buffer.byteLength(html))) return false
        const identity = createHash('sha256').update(id).update('\0').update(sourceUrl).update('\0')
          .update(String(Buffer.byteLength(html))).update(':').update(html)
        for (const [hash, resource] of [...frozenResources].sort(([left], [right]) => left.localeCompare(right))) {
          identity.update(hash).update(String(resource.mimeType.length)).update(':').update(resource.mimeType)
        }
        const snapshotId = identity.digest('hex').slice(0, 48)
        const snapshot = { id: snapshotId, appSessionId: binding.appSessionId, sourceUrl, html, resources: frozenResources, byteLength: Buffer.byteLength(html) + [...frozenResources.values()].reduce((sum, resource) => sum + resource.body.byteLength, 0) }
        snapshots.delete(snapshotId); snapshots.set(snapshotId, snapshot); latestSnapshot.set(id, snapshotId)
        return true
      })().finally(() => { pendingCaptures.delete(captureKey) })
      pendingCaptures.set(captureKey, pending)
      return timed(pending, false)
    },
    get(id: string): LocalhostFrozenSnapshot | null { return snapshots.get(id) ?? snapshots.get(latestSnapshot.get(id) ?? '') ?? null },
    find(appSessionId: string, url: string): LocalhostFrozenSnapshot | null {
      return [...snapshots.values()].reverse().find(snapshot => snapshot.appSessionId === appSessionId && snapshot.sourceUrl === url) ?? null
    },
    release: releaseLive,
    retireSession(appSessionId: string): void {
      for (const lease of [...leases.values()]) if (lease.appSessionId === appSessionId) releaseLive(lease.id)
      for (const [id, snapshot] of snapshots) if (snapshot.appSessionId === appSessionId) deleteSnapshot(id)
    },
    dispose(): void {
      disposed = true
      stopObserver()
      snapshots.clear(); latestSnapshot.clear()
    },
  }
}
