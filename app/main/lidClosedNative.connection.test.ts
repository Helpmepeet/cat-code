import { expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { LidNativeClient, parseLidNativeReply } from './lidClosedNative.js'

const identity = '0b8b8c9d-4e6f-4a51-9e1a-2b3c4d5e6f70'

test('late native exit releases only its captured claim after the bounded close deadline', async () => {
  const client = new LidNativeClient()
  const state = client as unknown as {
    child: unknown
    closing: Map<unknown, Promise<boolean>>
  }
  const fake = () => {
    const signals: string[] = []
    const child = Object.assign(new EventEmitter(), {
      pid: 987654, exitCode: null, signalCode: null, stdin: new PassThrough(),
      kill(signal: string) { signals.push(signal); return true },
    })
    return { child, signals }
  }
  const first = fake()
  state.child = first.child
  try {
    expect(await client.close()).toBe(false)
    expect(first.signals).toEqual(['SIGTERM', 'SIGKILL'])
    expect(first.child.listenerCount('exit')).toBe(1)
    expect(state.closing.has(first.child)).toBe(true)
    first.child.emit('exit', null, 'SIGKILL')
    expect(state.closing.size).toBe(0)
    expect(await client.close()).toBe(true)

    const second = fake()
    state.child = second.child
    const pending = client.close()
    first.child.emit('exit', null, 'SIGKILL')
    expect(state.closing.has(second.child)).toBe(true)
    second.child.emit('exit', null, 'SIGTERM')
    expect(await pending).toBe(true)
    expect(state.closing.size).toBe(0)
  } finally {
    // These are EventEmitters with inert kill methods, never OS processes.
    for (const child of state.closing.keys()) (child as EventEmitter).emit('exit', null, 'SIGKILL')
    await client.close(true)
  }
})

function workSnapshot(record: Record<string, unknown>) {
  return { record: { phase: 'active', began: 1, deadline: 2, allowance: 10, needsRestore: true,
    sleepRequested: false, sleepRequestAttempted: false, ...record },
    safety: { sleepDisabled: true, lidClosed: false, thermal: 'nominal' },
    remainingSeconds: 1, hardwareQualified: true }
}

test('native decoder preserves v1 success without pretending it is a v2 work receipt', () => {
  const decoded = parseLidNativeReply({ ok: true, snapshot: workSnapshot({ version: 1, identity }) })
  expect(decoded.ok).toBe(true)
  expect(decoded.snapshot?.record.version).toBe(1)
  expect(decoded.snapshot?.record.mode).toBeUndefined()
})

test('native decoder accepts v2 work snapshots and rejects incomplete v2 receipts', () => {
  const good = parseLidNativeReply({ ok: true, snapshot: workSnapshot({
    version: 2, mode: 'work', renewalSequence: 4, identity,
  }) })
  expect(good.ok).toBe(true)
  expect(good.snapshot?.record).toMatchObject({ version: 2, mode: 'work', renewalSequence: 4 })
  expect(() => parseLidNativeReply({ ok: true, snapshot: workSnapshot({ version: 2, identity }) })).toThrow()
  expect(() => parseLidNativeReply({ ok: true, snapshot: workSnapshot({ version: 2, mode: 'work', renewalSequence: 1.5, identity }) })).toThrow()
})

// Real bridge processes and stdin/stdout, with only the fixed executable path
// relocated in this test bundle. No root helper or service is installed.
test('an unavailable XPC generation is discarded before the next native request', async () => {
  const directory = mkdtempSync('/private/tmp/cat-lid-connection-')
  let client: import('./lidClosedNative.js').LidNativeClient | undefined
  try {
    const counter = join(directory, 'connections')
    const helper = join(directory, 'bridge')
    const snapshot = { record: { version: 1, phase: 'off', began: 0, deadline: 0, allowance: 0,
      needsRestore: false, sleepRequested: false, sleepRequestAttempted: false },
      safety: { sleepDisabled: false, lidClosed: false, thermal: 'nominal' }, remainingSeconds: 0, hardwareQualified: true }
    writeFileSync(helper, `#!${process.execPath}
      import { existsSync, writeFileSync } from 'node:fs';
      import { createInterface } from 'node:readline';
      const stale = !existsSync(${JSON.stringify(counter)});
      writeFileSync(${JSON.stringify(counter)}, 'connected');
      createInterface({ input: process.stdin }).on('line', () => {
        console.log(JSON.stringify(stale ? { ok: false, error: 'helper-unavailable' } : ${JSON.stringify({ ok: true, snapshot })}));
      });`)
    chmodSync(helper, 0o700)
    const built = await Bun.build({ entrypoints: [new URL('./lidClosedNative.ts', import.meta.url).pathname], target: 'bun',
      plugins: [{ name: 'fixed-bridge-fixture', setup(builder) {
        builder.onLoad({ filter: /lidClosedNative\.ts$/ }, args => ({ loader: 'ts', contents:
          readFileSync(args.path, 'utf8').replace("'/Library/PrivilegedHelperTools/com.catcode.lid-closed'", JSON.stringify(helper)) }))
      } }] })
    expect(built.success).toBe(true)
    const output = join(directory, 'adapter.mjs')
    await Bun.write(output, built.outputs[0]!)
    const adapter = await import(pathToFileURL(output).href) as typeof import('./lidClosedNative.js')
    expect(adapter.LID_HELPER).toBe(helper)
    client = new adapter.LidNativeClient()
    expect((await client.command({ op: 'status' })).ok).toBe(false)
    expect((await client.command({ op: 'status' })).snapshot?.safety.sleepDisabled).toBe(false)
  } finally { await client?.close(true); rmSync(directory, { recursive: true, force: true }) }
})

test('a missing private helper can recover after its executable becomes available', async () => {
  const directory = mkdtempSync('/private/tmp/cat-lid-missing-')
  let client: LidNativeClient | undefined
  try {
    const helper = join(directory, 'bridge')
    const built = await Bun.build({ entrypoints: [new URL('./lidClosedNative.ts', import.meta.url).pathname], target: 'bun',
      plugins: [{ name: 'missing-bridge-fixture', setup(builder) {
        builder.onLoad({ filter: /lidClosedNative\.ts$/ }, args => ({ loader: 'ts', contents:
          readFileSync(args.path, 'utf8').replace("'/Library/PrivilegedHelperTools/com.catcode.lid-closed'", JSON.stringify(helper)) }))
      } }] })
    expect(built.success).toBe(true)
    const output = join(directory, 'adapter.mjs')
    await Bun.write(output, built.outputs[0]!)
    const adapter = await import(pathToFileURL(output).href) as typeof import('./lidClosedNative.js')
    expect(adapter.LID_HELPER).toBe(helper)
    client = new adapter.LidNativeClient()
    await expect(client.command({ op: 'status' })).rejects.toThrow('Helper unavailable')
    const snapshot = { record: { version: 1, phase: 'off', began: 0, deadline: 0, allowance: 0,
      needsRestore: false, sleepRequested: false, sleepRequestAttempted: false },
      safety: { sleepDisabled: false, thermal: 'nominal' }, remainingSeconds: 0, hardwareQualified: true }
    writeFileSync(helper, `#!${process.execPath}
      import { createInterface } from 'node:readline';
      createInterface({input:process.stdin}).on('line',()=>console.log(${JSON.stringify(JSON.stringify({ ok: true, snapshot }))}));`)
    chmodSync(helper, 0o700)
    expect((await client.command({ op: 'status' })).snapshot?.safety.sleepDisabled).toBe(false)
    expect(await client.close()).toBe(true)
  } finally { await client?.close(true); rmSync(directory, { recursive: true, force: true }) }
})

test('native shutdown confirms captured fixture exit after TERM escalation and closes admission', async () => {
  const directory = mkdtempSync('/private/tmp/cat-lid-shutdown-')
  let client: import('./lidClosedNative.js').LidNativeClient | undefined
  try {
    const helper = join(directory, 'bridge')
    const pidFile = join(directory, 'pid')
    writeFileSync(helper, `#!${process.execPath}
      import { createInterface } from 'node:readline';
      import { writeFileSync } from 'node:fs';
      writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
      process.on('SIGTERM',()=>{});
      createInterface({input:process.stdin}).on('line',()=>console.log(JSON.stringify({ok:false,error:'fixture'})));
      setInterval(()=>{},1000);`)
    chmodSync(helper, 0o700)
    const built = await Bun.build({ entrypoints: [new URL('./lidClosedNative.ts', import.meta.url).pathname], target: 'bun',
      plugins: [{ name: 'owned-bridge-fixture', setup(builder) {
        builder.onLoad({ filter: /lidClosedNative\.ts$/ }, args => ({ loader: 'ts', contents:
          readFileSync(args.path, 'utf8').replace("'/Library/PrivilegedHelperTools/com.catcode.lid-closed'", JSON.stringify(helper)) }))
      } }] })
    expect(built.success).toBe(true)
    const output = join(directory, 'adapter.mjs')
    await Bun.write(output, built.outputs[0]!)
    const adapter = await import(pathToFileURL(output).href) as typeof import('./lidClosedNative.js')
    expect(adapter.LID_HELPER).toBe(helper)
    client = new adapter.LidNativeClient()
    expect((await client.command({ op: 'status' })).ok).toBe(false)
    const closing = client.close(true)
    await expect(client.command({ op: 'status' })).rejects.toThrow('Helper unavailable')
    expect(await closing).toBe(true)
    const pid = Number(readFileSync(pidFile, 'utf8'))
    expect(() => process.kill(pid, 0)).toThrow()
  } finally { await client?.close(true); rmSync(directory, { recursive: true, force: true }) }
})

// A bridge that answers one heartbeat and then goes silent, as a stalled XPC
// reply would. The trace must say the request timed out and why the bridge
// was replaced, because the helper's five-second limit leaves no other record.
test('a silent bridge is traced as a timeout, a closed bridge, and a replacement', async () => {
  const directory = mkdtempSync('/private/tmp/cat-lid-trace-')
  let client: import('./lidClosedNative.js').LidNativeClient | undefined
  try {
    const counter = join(directory, 'connections')
    const helper = join(directory, 'bridge')
    const snapshot = { record: { version: 1, phase: 'off', began: 0, deadline: 0, allowance: 0,
      needsRestore: false, sleepRequested: false, sleepRequestAttempted: false },
      safety: { sleepDisabled: false, lidClosed: false, thermal: 'nominal' }, remainingSeconds: 0, hardwareQualified: true }
    writeFileSync(helper, `#!${process.execPath}
      import { existsSync, writeFileSync } from 'node:fs';
      import { createInterface } from 'node:readline';
      const first = !existsSync(${JSON.stringify(counter)});
      writeFileSync(${JSON.stringify(counter)}, 'connected');
      let answered = 0;
      createInterface({ input: process.stdin }).on('line', () => {
        if (first && answered++ > 0) return;
        console.log(JSON.stringify(${JSON.stringify({ ok: true, snapshot })}));
      });`)
    chmodSync(helper, 0o700)
    const built = await Bun.build({ entrypoints: [new URL('./lidClosedNative.ts', import.meta.url).pathname], target: 'bun',
      plugins: [{ name: 'fixed-bridge-fixture', setup(builder) {
        builder.onLoad({ filter: /lidClosedNative\.ts$/ }, args => ({ loader: 'ts', contents:
          readFileSync(args.path, 'utf8').replace("'/Library/PrivilegedHelperTools/com.catcode.lid-closed'", JSON.stringify(helper)) }))
      } }] })
    expect(built.success).toBe(true)
    const output = join(directory, 'adapter.mjs')
    await Bun.write(output, built.outputs[0]!)
    const adapter = await import(pathToFileURL(output).href) as typeof import('./lidClosedNative.js')
    const commands: { op: string; outcome: string; durationMs: number }[] = []
    const bridges: { phase: string; reason?: string; pid?: number }[] = []
    client = new adapter.LidNativeClient({
      command: (op, _queueMs, durationMs, outcome) => { commands.push({ op, outcome, durationMs }) },
      bridge: (phase, fields = {}) => { bridges.push({ phase, reason: fields.reason, pid: fields.pid }) },
    })
    expect((await client.command({ op: 'status' })).ok).toBe(true)
    await expect(client.command({ op: 'pulse', identity })).rejects.toThrow('Helper unavailable')
    expect((await client.command({ op: 'status' })).ok).toBe(true)
    expect(commands.map(item => `${item.op}:${item.outcome}`)).toEqual(['status:ok', 'pulse:timeout', 'status:ok'])
    expect(commands[1]!.durationMs).toBeGreaterThanOrEqual(1900)
    const spawned = bridges.filter(item => item.phase === 'spawned')
    expect(spawned).toHaveLength(2)
    expect(bridges).toContainEqual({ phase: 'closing', reason: 'timeout', pid: spawned[0]!.pid })
    expect(bridges.some(item => item.phase === 'close-confirmed' && item.pid === spawned[0]!.pid)).toBe(true)
  } finally { await client?.close(true); rmSync(directory, { recursive: true, force: true }) }
})
