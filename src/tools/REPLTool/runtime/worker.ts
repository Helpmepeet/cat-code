import { newQuickJSWASMModule, type QuickJSDeferredPromise, type QuickJSHandle } from 'quickjs-emscripten'
import variant from '@jitl/quickjs-singlefile-cjs-release-sync'
import { boundRuntimeError, encode, type RuntimeLimits } from './protocol'
import { transform } from './transform'

const scope = globalThis as unknown as { postMessage(v: unknown): void; onmessage: (e: MessageEvent) => void }
const modulePromise = newQuickJSWASMModule(variant)
let runtime: ReturnType<Awaited<typeof modulePromise>['newRuntime']>
let ctx: ReturnType<typeof runtime.newContext>
let limits: RuntimeLimits
let current: string | undefined
let hasBash = false
let deadline = 0
let waitRevision: number | undefined
let waitStarted: number | undefined
let nextRequest = 0
let requests = 0
let outputBytes = 0
const pending = new Map<number, QuickJSDeferredPromise>()
let running = false
let settled = false
let failure: string | undefined
let pumpScheduled = false
let heapExceeded = false
const watched = new Set<QuickJSHandle>()
function unresolvedContinuations(): boolean {
  for (const handle of watched) {
    const state = ctx.getPromiseState(handle)
    if (state.type === 'pending') continue
    if (state.type === 'fulfilled') state.value.dispose()
    else state.error.dispose()
    watched.delete(handle); handle.dispose()
  }
  return watched.size > 0
}
function heapOverLimit(): boolean {
  if (heapExceeded) return true
  const usage = runtime.computeMemoryUsage()
  try {
    const size = ctx.getProp(usage, 'memory_used_size')
    try { heapExceeded = ctx.getNumber(size) > limits.memoryBytes } finally { size.dispose() }
  } finally { usage.dispose() }
  return heapExceeded
}
function send(v: unknown) { scope.postMessage(v) }
function pump() {
  if (pumpScheduled) return
  pumpScheduled = true
  setTimeout(() => {
    pumpScheduled = false
    if (!running || waitStarted !== undefined) return
    try {
      const result = runtime.executePendingJobs(64)
      if (result.error) { result.error.dispose(); throw new Error('Guest microtask failed') }
      if (heapOverLimit()) throw new Error('Retained heap limit')
      if (performance.now() >= deadline) throw new Error('Cell computation limit')
      if (runtime.hasPendingJob()) { pump(); return }
      if (waitRevision !== undefined && pending.size > 0) {
        waitStarted = performance.now()
        send({ type: 'human-wait', cellId: current, revision: waitRevision })
        return
      }
      if (settled && pending.size === 0) {
        if (unresolvedContinuations()) throw new Error('Unresolved guest continuation: runtime fenced; retained state discarded')
        running = false
        send({ type: 'done', cellId: current, error: failure })
        current = undefined
      }
    } catch (e) { send({ type: 'fatal', error: String(e).slice(0, 2048) }) }
  }, 0)
}
function readString(handle: Parameters<typeof ctx.getString>[0]): string {
  const text = ctx.getString(handle)
  if (new TextEncoder().encode(text).length > limits.messageBytes) throw new Error('Message byte limit')
  encode(JSON.parse(text), limits.messageBytes)
  return text
}
async function initialize(l: RuntimeLimits) {
  limits = l
  const module = await modulePromise
  runtime = module.newRuntime()
  runtime.setMemoryLimit(l.memoryBytes)
  runtime.setMaxStackSize(l.stackBytes)
  // The allocator limit alone does not account for every retained array resize
  // in this WASM build. Measure live guest storage as well, including across cells.
  runtime.setInterruptHandler(() => running && (performance.now() >= deadline || heapOverLimit()))
  runtime.removeModuleLoader()
  ctx = runtime.newContext()
  const watch = ctx.newFunction('__cmWatch', value => {
    const state = ctx.getPromiseState(value)
    if (state.type === 'fulfilled') {
      state.value.dispose()
      if (state.notAPromise) return { error: ctx.newError('Expected native promise') }
    } else if (state.type === 'rejected') state.error.dispose()
    if (watched.size >= 4096) {
      unresolvedContinuations()
      if (watched.size >= 4096) return { error: ctx.newError('Tracked promise limit') }
    }
    watched.add(value.dup())
    return value.dup()
  })
  ctx.setProp(ctx.global, '__cmWatch', watch); watch.dispose()
  const bridge = ctx.newFunction('__bridge', (kindHandle, dataHandle, stackHandle) => {
    try {
      if (!current || !running) throw new Error('No active cell')
      const kind = ctx.getString(kindHandle)
      const text = readString(dataHandle)
      const stack = ctx.getString(stackHandle)
      // Stack strings are diagnostics only, never evidence of admission. A new
      // owner is admitted only after all guest promises and jobs have drained.
      const match = stack.match(/cell-([a-zA-Z0-9_-]+)\.js:(\d+)/)
      const line = match ? Number(match[2]) : undefined
      const sourceCellId = match?.[1]
      if (kind === 'console' || kind === 'selected') {
        outputBytes += Math.max(64, new TextEncoder().encode(text).length)
        if (outputBytes > limits.outputBytes) throw new Error('Output byte limit')
        send({ type: 'output', cellId: current, kind, text, line, sourceCellId })
        return ctx.undefined
      }
      if (kind === 'shell' && !hasBash) throw new Error('sh requires a granted Bash tool')
      if (kind !== 'tool' && kind !== 'discover' && kind !== 'shell') throw new Error('Unknown bridge request')
      if (++requests > limits.totalRequests || pending.size >= limits.pendingRequests) throw new Error('Request limit')
      const id = ++nextRequest
      const promise = ctx.newPromise()
      pending.set(id, promise)
      send({ type: 'request', id, cellId: current, kind, text, line, sourceCellId })
      return promise.handle
    } catch (e) { return { error: ctx.newError(String(e).slice(0, 2048)) } }
  })
  ctx.setProp(ctx.global, '__bridge', bridge)
  bridge.dispose()
  // Capture authority and serialization intrinsics before guest code can mutate globals.
  const bootstrap = ctx.evalCode(`(() => {
    "use strict";
    const bridge = __bridge, stringify = JSON.stringify, ErrorType = Error;
    const NativePromise = Promise, nativeThen = Promise.prototype.then;
    const watch = __cmWatch, apply = Reflect.apply, define = Object.defineProperty;
    delete globalThis.__cmWatch;
    const adopt = value => watch(NativePromise.resolve(value));
    define(globalThis, '__cmAdopt', { value: adopt });
    const TrackedPromise = function Promise(executor) {
      if (!new.target) throw new TypeError('Promise requires new');
      return watch(new NativePromise(executor));
    };
    define(TrackedPromise, 'prototype', { value: NativePromise.prototype });
    define(NativePromise.prototype, 'constructor', { value: TrackedPromise, writable: false, configurable: false });
    define(NativePromise.prototype, 'then', { value: function(...args) { return watch(apply(nativeThen, this, args)); }, writable: false, configurable: false });
    for (const name of ['resolve', 'reject', 'all', 'allSettled', 'race', 'any']) {
      const fn = NativePromise[name];
      if (fn) define(TrackedPromise, name, { value: (...args) => watch(apply(fn, NativePromise, args)) });
    }
    define(globalThis, 'Promise', { value: TrackedPromise, writable: false, configurable: false });
    const disabled = () => { throw new ErrorType('Dynamic guest compilation is disabled'); };
    for (const fn of [function(){}, async function(){}, function*(){}, async function*(){}]) {
      define(Object.getPrototypeOf(fn), 'constructor', { value: disabled, writable: false, configurable: false });
    }
    define(globalThis, 'eval', { value: disabled, writable: false, configurable: false });
    define(globalThis, 'Function', { value: disabled, writable: false, configurable: false });
    const keys = Reflect.ownKeys, descriptor = Object.getOwnPropertyDescriptor;
    const getPrototype = Object.getPrototypeOf, plainPrototype = Object.prototype;
    const isArray = Array.isArray, finite = Number.isFinite;
    const validate = (value, display = true, ancestors = [], depth = 0) => {
      if (depth > 64) throw new ErrorType('JSON nesting limit');
      if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
      if (typeof value === 'number' && finite(value)) return;
      if (typeof value !== 'object' || ancestors.includes(value)) throw new ErrorType('Non-JSON data');
      const array = isArray(value), proto = getPrototype(value);
      if (!array && proto !== plainPrototype && proto !== null) throw new ErrorType('Non-plain data');
      const next = [...ancestors, value];
      for (const key of keys(value)) {
        if (array && key === 'length') continue;
        if (typeof key !== 'string' || key === '__proto__' || key === 'constructor' || key === 'prototype') throw new ErrorType('Unsafe JSON key');
        const d = descriptor(value, key);
        if (!('value' in d) || !d.enumerable) throw new ErrorType('Non-data property');
        if (display && !array && d.value === undefined) continue;
        validate(d.value, display, next, depth + 1);
      }
    };
    delete globalThis.__bridge;
    const call = (kind, value) => {
      validate(value, kind === 'selected' || kind === 'console');
      return bridge(kind, stringify(value), new ErrorType().stack);
    };
    const shellTag = async (strings, ...values) => {
      let request;
      try {
        request = { literals: strings?.raw, values };
        validate(request, false);
      } catch {
        return { isError: true, content: 'Use sh as a tagged template with strings, finite numbers, or nonempty arrays of those values.' };
      }
      try { return await call('shell', request); } catch (error) {
        return { isError: true, content: typeof error?.message === 'string' ? error.message : 'Shell request failed' };
      }
    };
    define(globalThis, '__cellBindings', { value: hasBash => {
      return {
        sh: hasBash ? shellTag : undefined,
        tools: Object.freeze({ call: value => call('tool', value), discover: value => call('discover', value) }),
        output: value => call('selected', value),
        console: Object.freeze({ log: (...args) => call('console', args), warn: (...args) => call('console', args), error: (...args) => call('console', args) })
      };
    } });
  })()`)
  ctx.unwrapResult(bootstrap).dispose()
}
scope.onmessage = async ({ data }) => {
  try {
    if (data.type === 'init') { await initialize(data.limits); send({ type: 'ready' }); return }
    if (data.type === 'run') {
      let source: string
      try {
        hasBash = data.hasBash === true
        source = transform(data.source, hasBash)
      } catch (error) {
        // Parsing and profile validation run before guest state can change.
        send({ type: 'done', cellId: data.cellId, error: String(error).slice(0, 2048) })
        return
      }
      current = data.cellId
      deadline = performance.now() + limits.wallTimeMs
      waitRevision = undefined
      waitStarted = undefined
      running = true; settled = false; failure = undefined; requests = 0; outputBytes = 0
      const result = ctx.evalCode(source, `cell-${current}.js`, { type: 'global' })
      if (result.error) {
        if (performance.now() >= deadline || heapExceeded) {
          result.error.dispose()
          send({ type: 'fatal', error: heapExceeded ? 'Retained heap limit' : 'Cell computation limit' })
          return
        }
        failure = String(ctx.dump(result.error)?.message ?? 'Guest exception').slice(0, 2048)
        result.error.dispose(); settled = true
      } else {
        const handle = ctx.unwrapResult(result)
        void ctx.resolvePromise(handle).then(resolved => {
          if (resolved.error) { failure = boundRuntimeError(String(ctx.dump(resolved.error)?.message ?? 'Guest exception')); resolved.error.dispose() }
          else ctx.unwrapResult(resolved).dispose()
          settled = true; pump()
        })
        handle.dispose()
      }
      pump()
    } else if (data.type === 'set-human-wait') {
      if (current !== data.cellId || !running) return
      if (data.waiting) {
        waitRevision = data.revision
      } else {
        waitRevision = undefined
        if (waitStarted !== undefined) deadline += performance.now() - waitStarted
        waitStarted = undefined
      }
      pump()
    } else if (data.type === 'response') {
      const promise = pending.get(data.id)
      if (!promise) return
      pending.delete(data.id)
      const value = data.error ? ctx.newError(data.error) : ctx.unwrapResult(ctx.evalCode(`JSON.parse(${JSON.stringify(data.text)})`))
      if (data.error) promise.reject(value)
      else promise.resolve(value)
      value.dispose(); promise.dispose(); pump()
    }
  } catch (e) { send({ type: 'fatal', error: String(e).slice(0, 2048) }) }
}
