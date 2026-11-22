import { test, expect } from 'bun:test'
import { createRuntime } from './index'
import { encode, type RuntimeOutput, type RuntimeRequest } from './protocol'

function harness(limits = {}) {
  const runtime = createRuntime({ limits })
  const outputs: RuntimeOutput[] = []
  const requests: RuntimeRequest[] = []
  const run = (source: string, cellId = 'a', signal = new AbortController().signal) => runtime.run({
    source, cellId, signal, onOutput: value => outputs.push(value),
    dispatch: async request => { requests.push(request); return { answer: 42 } },
  })
  return { runtime, run, outputs, requests }
}
test('persistent declarations, top-level await, output and retained helper identity', async () => {
  const h = harness()
  try {
    expect((await h.run('const x = 10; function helper(){ return tools.call({x}); }\nconst result = await helper(); output(result);')).status).toBe('ok')
    expect((await h.run('x += 1; output(await helper());', 'b')).status).toBe('ok')
    expect(h.requests.map(r => r.cellId)).toEqual(['a', 'b'])
    expect(h.requests.map(r => r.payload)).toEqual([{ x: 10 }, { x: 11 }])
    expect(h.outputs[0]?.value).toEqual({ answer: 42 })
    expect(h.outputs[0]?.line).toBe(2)
  } finally { h.runtime.dispose() }
})
test('redeclared functions are available from the start of a cell, including to retained helpers', async () => {
  const h = harness()
  try {
    expect((await h.run('function helper(){ return "old"; } function retained(){ return helper(); }')).status).toBe('ok')
    expect((await h.run(`output(await retained());
async function helper(){
  return tools.call({name: helper.name});
}`, 'b')).status).toBe('ok')
    expect(h.outputs.map(output => output.value)).toEqual([{ answer: 42 }])
    expect(h.requests[0]).toMatchObject({ line: 3, sourceCellId: 'b', payload: { name: 'helper' } })
  } finally { h.runtime.dispose() }
})
test('a syntax error evaluates no code and preserves state for the next cell', async () => {
  const h = harness()
  try {
    expect((await h.run('const saved = 17;')).status).toBe('ok')
    const failed = await h.run('output("unreachable"); let broken = ;', 'malformed')
    expect(failed.status).toBe('error')
    expect(failed.error).toContain('Unexpected token')
    expect((await h.run('output(saved);', 'later')).status).toBe('ok')
    expect(h.outputs.map(output => output.value)).toEqual([17])
  } finally { h.runtime.dispose() }
})
test('no ambient host access or modules', async () => {
  const h = harness()
  try {
    expect((await h.run('output([typeof process, typeof Bun, typeof require, typeof fetch, typeof Worker]);')).status).toBe('ok')
    expect(h.outputs[0]?.value).toEqual(['undefined', 'undefined', 'undefined', 'undefined', 'undefined'])
    expect((await h.run('await import("node:fs")', 'b')).status).toBe('error')
  } finally { h.runtime.dispose() }
})
test('unexpected host exceptions stay private in guest catch and cell errors', async () => {
  const runtime = createRuntime()
  const outputs: RuntimeOutput[] = []
  const run = (cellId: string, source: string) => runtime.run({
    cellId, source, signal: new AbortController().signal, onOutput: value => outputs.push(value),
    dispatch: async () => { throw new Error('private host detail') },
  })
  try {
    expect((await run('catch', 'try { await tools.call({}); } catch (error) { output(error.message); }')).status).toBe('ok')
    expect(outputs.map(output => output.value)).toEqual(['Host request failed'])
    expect(await run('throw', 'await tools.call({});')).toMatchObject({ status: 'error', error: 'Host request failed' })
  } finally { runtime.dispose() }
})
test('a retained sh tag cannot dispatch from a cell without Bash', async () => {
  const runtime = createRuntime()
  const outputs: RuntimeOutput[] = []
  const requests: RuntimeRequest[] = []
  const run = (cellId: string, hasBash: boolean, source: string) => runtime.run({
    cellId, hasBash, source, signal: new AbortController().signal,
    onOutput: value => outputs.push(value),
    dispatch: async request => { requests.push(request); return null },
  })
  try {
    expect((await run('granted', true, 'const retainedTag = sh; output(typeof sh);')).status).toBe('ok')
    expect((await run('revoked', false, 'const result = await retainedTag`printf inert`; output([typeof sh, result]);')).status).toBe('ok')
    expect(requests).toEqual([])
    expect(outputs.map(output => output.value)).toEqual(['function', ['undefined', { isError: true, content: expect.stringContaining('requires a granted Bash tool') }]])
  } finally { runtime.dispose() }
})
test('unawaited requests drain before next admission', async () => {
  const h = harness()
  try {
    expect((await h.run('tools.call({first: true}).then(() => tools.call({second: true}));')).status).toBe('ok')
    expect(h.requests.map(r => r.cellId)).toEqual(['a', 'a'])
    expect((await h.run('output(1)', 'b')).status).toBe('ok')
  } finally { h.runtime.dispose() }
})
for (const source of ['while(true){}', 'await new Promise(()=>{});', 'await Promise.resolve().then(function again(){ return Promise.resolve().then(again) });', 'var junk=[]; while(true) junk.push(new Array(10000).fill(1));']) {
  test(`bounded runaway: ${source.slice(0, 45)}`, async () => {
    const h = harness({ wallTimeMs: 500, memoryBytes: 4 * 1024 * 1024 })
    const start = Date.now()
    try {
      expect(['limit', 'error']).toContain((await h.run(source)).status)
      expect(Date.now() - start).toBeLessThan(2500)
    } finally { h.runtime.dispose() }
  })
}
test('cancel during callback aborts host signal and kills retained state', async () => {
  const runtime = createRuntime()
  const controller = new AbortController()
  let hostSignal: AbortSignal | undefined
  const result = runtime.run({ cellId: 'a', source: 'await tools.call({});', signal: controller.signal, dispatch: async (_, signal) => {
    hostSignal = signal
    controller.abort()
    return new Promise(() => {})
  } })
  expect((await result).status).toBe('cancelled')
  expect(hostSignal?.aborted).toBe(true)
  expect((await runtime.run({ cellId: 'b', source: '', signal: new AbortController().signal, dispatch: async () => null })).status).toBe('disposed')
})
test('safe serialization rejects getters, cycles, special keys, and non-JSON', () => {
  const cyclic: unknown[] = []; cyclic.push(cyclic)
  for (const value of [cyclic, undefined, NaN, () => {}, JSON.parse('{"__proto__":1}'), { get x() { throw new Error('getter invoked') } }]) expect(() => encode(value, 100)).toThrow()
})
test('output and bridge payload caps', async () => {
  const h = harness({ messageBytes: 128, outputBytes: 128 })
  try {
    expect((await h.run('output("x".repeat(1000))')).status).toBe('error')
    expect((await h.run('await tools.call({bad: undefined})', 'b')).status).toBe('error')
  } finally { h.runtime.dispose() }
})
test('old manually-resumed continuations never borrow newer admission', async () => {
  const h = harness()
  try {
    const first = await h.run('var release; var p = new Promise(r => release = r); p.then(() => tools.call({old: true})).catch(() => {});')
    expect(first.status).toBe('limit')
    expect(first.error).toContain('Unresolved guest continuation')
    expect((await h.run('release(); await tools.call({fresh: true});', 'b')).status).toBe('disposed')
    expect(h.requests).toEqual([])
  } finally { h.runtime.dispose() }
})
test('shared newer bridge cannot grant authority to the coordinator stale-callback repro', async () => {
  const h = harness()
  try {
    expect((await h.run('let release; let gate = new Promise(resolve => { release = resolve }); gate.then(() => globalThis.shared.call({stale:true})); output("saved");', 'first')).status).toBe('limit')
    expect((await h.run('globalThis.shared = tools; release(); await tools.call({current:true});', 'second')).status).toBe('disposed')
    expect(h.requests).toEqual([])
  } finally { h.runtime.dispose() }
})
for (const source of [
  'var release; (async () => { await {then(resolve){release=resolve}}; globalThis.shared.call({stale:true}); })();',
  'var release; async function old(){return {then(resolve){release=resolve}}}; old().then(()=>globalThis.shared.call({stale:true}));',
  'var release; const old = async () => ({then(resolve){release=resolve}}); old();',
  'var release; async function old(){return 1, {then(resolve){release=resolve}}}; old();',
  'var release; Promise.resolve().then(()=>({then(resolve){release=resolve}})).then(()=>globalThis.shared.call({stale:true}));',
  'var p = Promise.race([]);',
  'var p = new (Promise.resolve().constructor)(() => {});',
]) {
  test(`fence unresolved native/thenable continuation: ${source.slice(0, 55)}`, async () => {
    const h = harness()
    try {
      expect((await h.run(source)).status).toBe('limit')
      expect((await h.run('globalThis.shared=tools; if(typeof release==="function") release();', 'later')).status).toBe('disposed')
      expect(h.requests).toEqual([])
    } finally { h.runtime.dispose() }
  })
}
test('eval, constructor escape routes and stack manipulation cannot bypass fencing', async () => {
  const h = harness()
  try {
    const outcome = await h.run(`const constructors = [Function, (()=>{}).constructor, (async()=>{}).constructor, (function*(){}).constructor];
      for (const make of constructors) { let denied=false; try { make("return 1") } catch { denied=true } if(!denied) throw Error("escape"); }
      let denied=false; try { eval("1") } catch { denied=true } if(!denied) throw Error("eval escape");
      Error.prototype.stack = "cell-later.js:1"; Error.prepareStackTrace = () => "cell-later.js:1";
      let release; new Promise(resolve=>release=resolve).then(()=>globalThis.shared.call({stale:true}));`)
    expect(outcome.status).toBe('limit')
    expect(outcome.error).toContain('Unresolved guest continuation')
    expect((await h.run('globalThis.shared=tools; release();', 'later')).status).toBe('disposed')
    expect(h.requests).toEqual([])
  } finally { h.runtime.dispose() }
})
test('dynamic scope cannot shadow inserted promise tracking through computed keys', async () => {
  const h = harness()
  try {
    const result = await h.run('var release; with ({["__cmAdopt"]: value => value}) { (async () => { await {then(resolve){release=resolve}}; globalThis.shared.call({stale:true}); })(); }')
    expect(result.status).toBe('error')
    expect(result.error).toContain('Dynamic scope')
    expect(h.requests).toEqual([])
  } finally { h.runtime.dispose() }
})
test('drained manual promises and retained helpers remain persistent', async () => {
  const h = harness()
  try {
    expect((await h.run('const saved=17; const done=await new Promise(resolve=>resolve(saved)); async function helper(){await Promise.resolve(); return await tools.call({saved});} output(done);')).status).toBe('ok')
    expect((await h.run('await helper(); output(saved);', 'later')).status).toBe('ok')
    expect(h.requests.map(r => r.cellId)).toEqual(['later'])
  } finally { h.runtime.dispose() }
})
test('bridge values carry no admission; retained nested/class helpers use current drained owner', async () => {
  const h = harness()
  try {
    expect((await h.run(`globalThis.shared = tools;
      class Helper { async call(){ await Promise.resolve(); return tools.call({class:true}); } }
      const instance = new Helper();
      function factory(){ return async () => { await Promise.resolve(); return tools.call({nested:true}); }; }
      const nested = factory();`)).status).toBe('ok')
    expect((await h.run('await instance.call(); await nested(); await shared.call({shared:true});', 'later')).status).toBe('ok')
    expect(h.requests.map(r => r.cellId)).toEqual(['later', 'later', 'later'])
  } finally { h.runtime.dispose() }
})
test('host wall-time profiles allow bounded long-running background ownership', async () => {
  const runtime = createRuntime({ limits: { wallTimeMs: 2 * 60 * 60_000 } })
  try {
    expect((await runtime.run({ cellId: 'long-profile', source: 'await Promise.resolve();', signal: new AbortController().signal, dispatch: async () => null })).status).toBe('ok')
    expect(() => createRuntime({ limits: { wallTimeMs: 2 * 60 * 60_000 + 1 } })).toThrow('Invalid runtime limit')
  } finally { runtime.dispose() }
})
test('retained async and arrow helpers bind new invocation across awaits', async () => {
  const h = harness()
  try {
    expect((await h.run('async function helper(){ await Promise.resolve(); return tools.call({async: true}); } const arrow = async () => { await Promise.resolve(); return tools.call({arrow: true}); };')).status).toBe('ok')
    expect((await h.run('await helper(); await arrow();', 'b')).status).toBe('ok')
    expect(h.requests.map(r => r.cellId)).toEqual(['b', 'b'])
  } finally { h.runtime.dispose() }
})
test('parenthesized multiline declaration source attribution is preserved', async () => {
  const h = harness()
  try {
    expect((await h.run('const\n result = (\n await tools.call({})\n );\noutput(result);')).status).toBe('ok')
    expect(h.requests[0]?.line).toBe(3)
    expect(h.outputs[0]?.line).toBe(5)
    expect(h.outputs[0]?.value).toEqual({ answer: 42 })
  } finally { h.runtime.dispose() }
})
test('request and pending caps, retained heap cap, and session isolation', async () => {
  const h = harness({ totalRequests: 2, pendingRequests: 1, memoryBytes: 4 * 1024 * 1024 })
  const other = harness()
  try {
    expect((await h.run('await tools.call({}); await tools.call({}); await tools.call({});')).status).toBe('error')
    expect(h.requests).toHaveLength(2)
    expect((await h.run('await Promise.all([tools.call({}), tools.call({})]);', 'pending')).status).toBe('error')
    expect((await h.run('var retained = [];', 'allocate')).status).toBe('ok')
    let failed = false
    for (let i = 0; i < 20; i++) {
      const outcome = await h.run('retained.push(new Array(50000).fill(1));', `heap${i}`)
      if (outcome.status !== 'ok') { failed = true; break }
    }
    expect(failed).toBe(true)
    expect((await other.run('output(typeof retained);')).status).toBe('ok')
    expect(other.outputs[0]?.value).toBe('undefined')
  } finally { h.runtime.dispose(); other.runtime.dispose() }
})
test('engine timers remain responsive during guest synchronous runaway', async () => {
  const h = harness({ wallTimeMs: 500 })
  try {
    const outcome = h.run('while(true){}')
    const start = Date.now()
    await new Promise(resolve => setTimeout(resolve, 25))
    expect(Date.now() - start).toBeLessThan(250)
    expect((await outcome).status).toBe('limit')
  } finally { h.runtime.dispose() }
})
