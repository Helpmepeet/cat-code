import { expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { Window } from 'happy-dom'
import { createLocalhostSnapshots, type LocalhostSnapshotBinding, type LocalhostSnapshotFrame } from './localhostSnapshot.js'

const binding = { id: 'a'.repeat(48), appSessionId: 'session-a', frameName: 'issued-preview', url: 'http://localhost:4321/page' }
function setup(options?: { limit?: number; timeout?: number; captures?: number; oopif?: boolean }) {
  const page = new Window({ url: binding.url, settings: { disableCSSFileLoading: true, disableJavaScriptFileLoading: true, enableJavaScriptEvaluation: true, suppressInsecureJavaScriptEnvironmentWarning: true } })
  page.document.write('<!doctype html><html onload="bad()"><head><link rel="stylesheet" href="/page.css"><script>bad()</script><meta http-equiv="refresh" content="0;url=https://example.invalid"></head><body><h1 class="hero" onclick="bad()">Live snapshot text</h1><img src="/cat.svg"><iframe src="/private"></iframe><form action="/post"><input value="old"></form></body></html>')
  page.document.querySelector('input')!.value = 'current value'
  const emitter = new EventEmitter()
  const bodies = new Map<string, { body: string; base64Encoded: boolean }>()
  const bodyReads: string[] = []
  const resumed: string[] = []
  const failedResumes = new Set<string>()
  let attached = false, evaluations = 0
  let holdBody: Promise<void> | null = null
  let holdEvaluation: Promise<void> | null = null
  const bindings: LocalhostSnapshotBinding[] = [binding]
  const frame: LocalhostSnapshotFrame = { name: binding.frameName, url: binding.url, parent: { parent: null }, executeJavaScript: async expression => page.eval(expression) }
  const transport = Object.assign(emitter, {
    isAttached: () => attached,
    attach: () => { attached = true },
    detach: () => { attached = false },
    sendCommand: async (method: string, params: Record<string, any>, sessionId?: string) => {
      if (method === 'Runtime.runIfWaitingForDebugger') { resumed.push(sessionId ?? ''); if (failedResumes.has(sessionId ?? '')) throw new Error('Session closed') }
      if (method === 'Page.getFrameTree' && sessionId) return { frameTree: { frame: { id: sessionId === 'child-session' ? 'preview' : 'nested', parentId: sessionId === 'child-session' ? 'app' : 'preview', name: binding.frameName, url: binding.url } } }
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'app', url: 'http://localhost:5189/' }, childFrames: options?.oopif ? [] : [
        ...bindings.map((item, index) => ({ frame: { id: index ? 'staging' : 'preview', parentId: 'app', name: item.frameName, url: item.url }, childFrames: index ? [] : [{ frame: { id: 'nested', parentId: 'preview', name: binding.frameName, url: binding.url } }] })),
      ] } }
      if (method === 'Page.createIsolatedWorld') return { executionContextId: 7 }
      if (method === 'Runtime.evaluate') {
        evaluations++
        const value = page.eval(params.expression)
        if (holdEvaluation) await holdEvaluation
        return { result: { type: typeof value, value } }
      }
      if (method === 'Network.getResponseBody') {
        bodyReads.push(params.requestId)
        if (holdBody) await holdBody
        return bodies.get(params.requestId) ?? { body: '', base64Encoded: false }
      }
      return {}
    },
  })
  const snapshots = createLocalhostSnapshots({ debugger: transport as never, bindings: () => bindings, devOrigin: 'http://localhost:5189', limits: {
    resourceBytes: options?.limit ?? 4096, captureTimeoutMs: options?.timeout ?? 600, captures: options?.captures ?? 4,
  } })
  const message = (method: string, params: object, sessionId?: string) => emitter.emit('message', {}, method, params, sessionId)
  const response = (id: string, input: { frame?: string; url: string; body: string; mime?: string; decoded?: number; failed?: boolean; type?: string }) => {
    bodies.set(id, { body: input.body, base64Encoded: false })
    message('Network.requestWillBeSent', { requestId: id, frameId: input.frame ?? 'preview', request: { url: input.url, method: 'GET' } }, options?.oopif ? 'child-session' : undefined)
    message('Network.responseReceived', { requestId: id, type: input.type ?? 'Stylesheet', response: { status: 200, mimeType: input.mime ?? 'text/css' } }, options?.oopif ? 'child-session' : undefined)
    message('Network.dataReceived', { requestId: id, dataLength: input.decoded ?? Buffer.byteLength(input.body), encodedDataLength: 1 }, options?.oopif ? 'child-session' : undefined)
    message(input.failed ? 'Network.loadingFailed' : 'Network.loadingFinished', { requestId: id, ...(input.failed ? { corsErrorStatus: { corsError: 'MissingAllowOriginHeader' } } : {}) }, options?.oopif ? 'child-session' : undefined)
  }
  const settle = async () => { for (let index = 0; index < 8; index++) await new Promise(resolve => setTimeout(resolve, 0)) }
  const hold = (kind: 'body' | 'evaluation') => {
    let resume!: () => void
    const pending = new Promise<void>(resolve => { resume = resolve })
    if (kind === 'body') holdBody = pending; else holdEvaluation = pending
    return resume
  }
  return { page, snapshots, frame, bindings, bodyReads, response, settle, hold, resumed, attachChild: (sessionId = 'child-session') => message('Target.attachedToTarget', { sessionId, targetInfo: { type: 'iframe', url: binding.url } }), detachChild: (sessionId: string) => message('Target.detachedFromTarget', { sessionId }), failResume: (sessionId: string) => failedResumes.add(sessionId), attached: () => attached, evaluations: () => evaluations, cleanup: () => { snapshots.dispose(); page.happyDOM.abort() } }
}

test('frozen preview uses captured styles and image bytes, keeps current DOM values, and removes active content', async () => {
  const state = setup({ oopif: true })
  try {
    expect(await state.snapshots.start()).toBe(true)
    state.attachChild(); state.attachChild('untrusted-nested-session')
    await state.settle()
    expect(state.resumed.sort()).toEqual(['child-session', 'untrusted-nested-session'])
    state.response('css', { url: 'http://localhost:4321/page.css', body: '.hero{color:rgb(12,34,56);background-image:url(/cat.svg)}' })
    state.response('image', { url: 'http://localhost:4321/cat.svg', type: 'Image', mime: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg"><rect width="9" height="9"/></svg>' })
    await state.settle()
    expect(await state.snapshots.capture(binding.id, state.frame)).toBe(true)
    const snapshot = state.snapshots.get(binding.id)!
    const frozen = new Window({ settings: { suppressInsecureJavaScriptEnvironmentWarning: true } })
    frozen.document.write(snapshot.html)
    expect(frozen.document.querySelector('h1')?.textContent).toBe('Live snapshot text')
    expect(frozen.document.querySelector('input')?.getAttribute('value')).toBe('current value')
    expect(frozen.document.querySelector('script,iframe,meta[http-equiv]')).toBeNull()
    expect([...frozen.document.querySelectorAll('*')].some(node => [...node.attributes].some(attribute => /^on/i.test(attribute.name)))).toBe(false)
    expect(frozen.document.querySelector('form')?.hasAttribute('inert')).toBe(true)
    expect(frozen.document.querySelector('form')?.hasAttribute('action')).toBe(false)
    const imageKey = frozen.document.querySelector('img')!.getAttribute('src')!.slice('asset/'.length)
    expect(snapshot.resources.get(imageKey)?.body.toString()).toContain('<rect width="9"')
    expect(snapshot.html).toContain(`url("asset/${imageKey}")`)
    expect(state.snapshots.find(binding.appSessionId, binding.url)).toBe(snapshot)
    state.bindings.length = 0
    state.snapshots.release(binding.id)
    expect(state.attached()).toBe(false)
    expect(state.snapshots.find(binding.appSessionId, binding.url)?.html).toContain('Live snapshot text')
    state.bindings.push(binding)
    expect(await state.snapshots.start()).toBe(true)
    expect(state.snapshots.get(snapshot.id)?.html).toContain('Live snapshot text')
    state.snapshots.retireSession(binding.appSessionId)
    expect(state.snapshots.find(binding.appSessionId, binding.url)).toBeNull()
    frozen.happyDOM.abort()
  } finally { state.cleanup() }
})

test('app, nested spoofed frames, CORS failures and decoded oversized resources never expose response bodies', async () => {
  const state = setup({ limit: 128 })
  try {
    await state.snapshots.start()
    state.response('valid', { url: 'http://localhost:4321/page.css', body: '.hero{color:red}' })
    state.response('app', { frame: 'app', url: 'http://localhost:5189/secret.css', body: 'APP SECRET' })
    state.response('nested', { frame: 'nested', url: 'http://localhost:4321/nested.css', body: 'NESTED SECRET' })
    state.response('cors', { url: 'http://127.0.0.1:9000/blocked.css', body: 'CORS SECRET', failed: true })
    state.response('bomb', { url: 'http://localhost:4321/bomb.css', body: 'x'.repeat(129), decoded: 129 })
    await state.settle()
    expect(state.bodyReads).toEqual(['valid'])
    expect(await state.snapshots.capture(binding.id, state.frame)).toBe(true)
    expect([...state.snapshots.get(binding.id)!.resources.values()].map(resource => resource.body.toString())).toEqual(['.hero{color:red}'])
    expect(await state.snapshots.capture(binding.id, { ...state.frame, parent: null })).toBe(false)
  } finally { state.cleanup() }
})

test('body lookups and timed out DOM captures stay bounded and a retired capture cannot publish later', async () => {
  const state = setup({ timeout: 15, captures: 1 })
  const resumeBody = state.hold('body')
  const resumeEvaluation = state.hold('evaluation')
  try {
    await state.snapshots.start()
    for (let index = 0; index < 20; index++) state.response(`body-${index}`, { url: `http://localhost:4321/${index}.css`, body: 'a{color:red}' })
    await state.settle()
    expect(state.bodyReads).toHaveLength(2)
    expect(await state.snapshots.capture(binding.id, state.frame)).toBe(false)
    expect(await state.snapshots.capture(binding.id, state.frame)).toBe(false)
    expect(state.evaluations()).toBe(1)
    state.snapshots.release(binding.id)
    state.bindings.length = 0
    resumeBody(); resumeEvaluation()
    await state.settle()
    expect(state.snapshots.get(binding.id)).toBeNull()
  } finally { resumeBody(); resumeEvaluation(); state.cleanup() }
})


test('freezing the painted frame keeps its assets separate from a staged revision of the same URL', async () => {
  const state = setup()
  try {
    state.bindings.push({ ...binding, frameName: 'new-staged-preview' })
    await state.snapshots.start()
    state.response('painted-css', { url: 'http://localhost:4321/page.css', body: '.hero{color:red}' })
    state.response('staged-css', { frame: 'staging', url: 'http://localhost:4321/page.css', body: '.hero{color:blue}' })
    await state.settle()
    expect(await state.snapshots.capture(binding.id, state.frame)).toBe(true)
    expect([...state.snapshots.get(binding.id)!.resources.values()].map(resource => resource.body.toString())).toEqual(['.hero{color:red}'])
    expect(await state.snapshots.capture(binding.id, { ...state.frame, name: 'new-staged-preview' })).toBe(true)
    expect([...state.snapshots.get(binding.id)!.resources.values()].map(resource => resource.body.toString())).toEqual(['.hero{color:blue}'])
  } finally { state.cleanup() }
})


test('a detached obsolete target cannot disable capture for the current page when its resume reply fails', async () => {
  const state = setup()
  try {
    await state.snapshots.start()
    state.failResume('untrusted-nested-session')
    state.attachChild('untrusted-nested-session')
    state.detachChild('untrusted-nested-session')
    await state.settle()
    expect(state.attached()).toBe(true)
    expect(await state.snapshots.capture(binding.id, state.frame)).toBe(true)
  } finally { state.cleanup() }
})

test('an issued frozen id keeps its old DOM and resource bytes after the same page is recaptured', async () => {
  const state = setup()
  try {
    await state.snapshots.start()
    state.response('old', { url: 'http://localhost:4321/page.css', body: '.hero{color:red}' })
    await state.settle()
    await state.snapshots.capture(binding.id, state.frame)
    const previous = state.snapshots.get(binding.id)!
    state.page.document.querySelector('h1')!.textContent = 'Changed current DOM'
    state.response('new', { url: 'http://localhost:4321/page.css', body: '.hero{color:blue}' })
    await state.settle()
    await state.snapshots.capture(binding.id, state.frame)
    const current = state.snapshots.get(binding.id)!
    expect(current.id).not.toBe(previous.id)
    expect(state.snapshots.get(previous.id)?.html).toContain('Live snapshot text')
    expect([...state.snapshots.get(previous.id)!.resources.values()].map(resource => resource.body.toString())).toEqual(['.hero{color:red}'])
    expect(state.snapshots.get(current.id)?.html).toContain('Changed current DOM')
  } finally { state.cleanup() }
})
